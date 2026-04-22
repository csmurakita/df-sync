import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import ignore from 'ignore'
import { matchesAlwaysExclude } from './exclude.js'

// git が利用可能かつ root が git リポジトリ配下なら git check-ignore で判定する
// (ネストされた .gitignore やグローバル設定も尊重される)。
// 利用不可の場合は ignore パッケージ + root/.gitignore にフォールバック。
// 返り値の関数には dispose() が付く (git 子プロセスのクリーンアップ用)。
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
  // stderr はパイプ詰まりを避けるため読み捨てる
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', () => {})

  const queue = []
  readNullRecords(child.stdout, 4, (fields) => {
    // -z --non-matching 時、非一致は source フィールドが空文字
    const matched = fields[0] !== ''
    queue.shift()?.resolve(matched)
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

  const predicate = async (path, isDir) => {
    if (matchesAlwaysExclude(path)) return true
    const input = isDir ? `${path}/` : path
    return new Promise((resolve, reject) => {
      queue.push({ resolve, reject })
      child.stdin.write(`${input}\0`)
    })
  }
  predicate.dispose = () => {
    try {
      child.stdin.end()
    } catch {}
  }
  return predicate
}

// stream を NUL 区切りで読み、fieldsPerRecord 個まとまるごとに onRecord にフィールド配列を渡す。
// チャンク境界で NUL が割れても繋ぎ直せるよう、buffer / fields は関数内部で保持する。
function readNullRecords(stream, fieldsPerRecord, onRecord) {
  stream.setEncoding('utf8')
  let buffer = ''
  let fields = []
  stream.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\0')) >= 0) {
      fields.push(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 1)
      if (fields.length === fieldsPerRecord) {
        const record = fields
        fields = []
        onRecord(record)
      }
    }
  })
}

async function createFallbackPredicate(root) {
  const ig = ignore()
  const gitignore = await tryReadText(join(root, '.gitignore'))
  if (gitignore !== null) ig.add(gitignore)
  const predicate = async (path, isDir) => {
    if (matchesAlwaysExclude(path)) return true
    const matchPath = isDir ? `${path}/` : path
    return ig.ignores(matchPath)
  }
  predicate.dispose = () => {}
  return predicate
}

async function tryReadText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}
