import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import ignore from 'ignore'

// どの深さにあっても除外するセグメント名
const ALWAYS_EXCLUDE_SEGMENTS = new Set(['.git', 'node_modules'])
// ルート直下にあるときだけ除外するファイル名
const ALWAYS_EXCLUDE_ROOT_FILES = new Set(['.df-credentials.json'])

export async function enumerateLocal(root, isIgnored) {
  const files = new Map()
  const dirs = []
  await walk(root, '', isIgnored, files, dirs)
  return { files, dirs }
}

// listFilter   : list() に適用する ignore 述語。null なら walk の ALWAYS_EXCLUDE のみ。
// shouldSkipDelete: --mirror 削除時にスキップ判定する述語（完全な local ignore を想定）。
export function localSide(root, { listFilter = null, shouldSkipDelete = null } = {}) {
  return {
    supportsRecursiveDirDelete: false,
    shouldSkipDelete,
    async list() {
      return enumerateLocal(root, listFilter)
    },
    async read(relPath) {
      return readFile(join(root, relPath))
    },
    async write(relPath, bytes) {
      const abs = join(root, relPath)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, bytes)
    },
    async removeFile(relPath) {
      await unlink(join(root, relPath))
    },
    async removeDirectory() {
      throw new Error('local destination に対するディレクトリ再帰削除はサポートされません')
    },
  }
}

// ALWAYS_EXCLUDE_SEGMENTS はどの階層でも、
// ALWAYS_EXCLUDE_ROOT_FILES はルート直下のときだけ true
export function matchesAlwaysExclude(path) {
  const segments = path.split('/')
  if (segments.some((seg) => ALWAYS_EXCLUDE_SEGMENTS.has(seg))) return true
  if (segments.length === 1 && ALWAYS_EXCLUDE_ROOT_FILES.has(segments[0])) return true
  return false
}

// git が利用可能かつ root が git リポジトリ配下なら git check-ignore で判定する
// (ネストされた .gitignore やグローバル設定も尊重される)。
// 利用不可の場合は ignore パッケージ + root/.gitignore にフォールバック。
export async function buildIgnorePredicate(root) {
  if (await isInsideGitRepo(root)) {
    return createGitIgnorePredicate(root)
  }
  return createFallbackPredicate(root)
}

async function isInsideGitRepo(root) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0 && stdout.trim() === 'true'))
  })
}

// long-running な git check-ignore 子プロセスを起動し、問い合わせごとに
// stdin へ NUL 区切りで path を書いて、stdout 側も -z の NUL 区切りで
// 1 レコード (source, linenum, pattern, path の 4 フィールド) を読む。
// --verbose --non-matching により 1 入力 = 1 レコード出力が保証される。
// 改行入りパスを素直に扱うため -z を使う。
async function createGitIgnorePredicate(root) {
  const child = spawn(
    'git',
    ['-C', root, 'check-ignore', '--stdin', '-z', '--verbose', '--non-matching', '--no-index'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  // stderr はパイプ詰まりを避けるため読み捨てる
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', () => {})

  const queue = []
  let buffer = ''
  let fields = []
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\0')) >= 0) {
      fields.push(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 1)
      if (fields.length === 4) {
        // -z --non-matching 時、非一致は source フィールドが空文字
        const matched = fields[0] !== ''
        fields = []
        const pending = queue.shift()
        if (pending) pending.resolve(matched)
      }
    }
  })
  const fail = (err) => {
    while (queue.length) queue.shift().reject(err)
  }
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.on('exit', (code, signal) => {
    if (queue.length > 0) {
      fail(new Error(`git check-ignore が予期せず終了しました (code=${code}, signal=${signal})`))
    }
  })

  return async (path, isDir) => {
    if (matchesAlwaysExclude(path)) return true
    const input = isDir ? `${path}/` : path
    return new Promise((resolve, reject) => {
      queue.push({ resolve, reject })
      child.stdin.write(`${input}\0`)
    })
  }
}

async function createFallbackPredicate(root) {
  const ig = ignore()
  const gitignore = await tryReadText(join(root, '.gitignore'))
  if (gitignore !== null) ig.add(gitignore)
  return async (path, isDir) => {
    if (matchesAlwaysExclude(path)) return true
    const matchPath = isDir ? `${path}/` : path
    return ig.ignores(matchPath)
  }
}

async function tryReadText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

async function walk(root, rel, isIgnored, files, dirs) {
  const absDir = rel ? join(root, rel) : root
  const entries = await readdir(absDir, { withFileTypes: true })
  for (const entry of entries) {
    if (ALWAYS_EXCLUDE_SEGMENTS.has(entry.name)) continue
    if (!rel && ALWAYS_EXCLUDE_ROOT_FILES.has(entry.name)) continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    const isDir = entry.isDirectory()
    if (isIgnored && (await isIgnored(childRel, isDir))) continue

    if (isDir) {
      dirs.push(childRel)
      await walk(root, childRel, isIgnored, files, dirs)
    } else if (entry.isFile()) {
      const info = await stat(join(absDir, entry.name))
      files.set(childRel, { sizeBytes: info.size })
    }
    // symlink, socket, etc. は同期対象外
  }
}
