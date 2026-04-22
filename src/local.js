import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import ignore from 'ignore'

export const ALWAYS_EXCLUDE = ['.git', 'node_modules', '.df-credentials.json']
const ALWAYS_EXCLUDE_SET = new Set(ALWAYS_EXCLUDE)

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

// path のいずれかのセグメントが ALWAYS_EXCLUDE にあれば true
export function matchesAlwaysExclude(path) {
  return path.split('/').some((seg) => ALWAYS_EXCLUDE_SET.has(seg))
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
// stdin へ path を書いて stdout の 1 行と FIFO 対応で結果を得る。
// --verbose --non-matching により 1 入力 1 出力が保証される。
function createGitIgnorePredicate(root) {
  const child = spawn(
    'git',
    ['-C', root, 'check-ignore', '--stdin', '--verbose', '--non-matching', '--no-index'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  const queue = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      const tabIdx = line.indexOf('\t')
      if (tabIdx < 0) continue
      const source = line.slice(0, tabIdx)
      const matched = source !== '::' // --non-matching 時の非一致は "::" で始まる
      const pending = queue.shift()
      if (pending) pending.resolve(matched)
    }
  })
  const fail = (err) => {
    while (queue.length) queue.shift().reject(err)
  }
  child.on('error', fail)
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
      child.stdin.write(`${input}\n`)
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
    if (ALWAYS_EXCLUDE_SET.has(entry.name)) continue
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
