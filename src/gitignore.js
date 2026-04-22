import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import ignore from 'ignore'
import { matchesAlwaysExclude } from './exclude.js'

/**
 * gitignore 述語。`(relPath, isDir) => boolean | Promise<boolean>` を満たし、
 * `dispose()` で裏で走らせている子プロセスのクリーンアップを行う。
 *
 * @typedef {((relPath: string, isDir: boolean) => Promise<boolean>) & { dispose: () => void }} IgnorePredicate
 */

// git が利用可能かつ root が git リポジトリ配下なら git check-ignore で判定する
// (ネストされた .gitignore やグローバル設定も尊重される)。
// 利用不可の場合は ignore パッケージ + root/.gitignore にフォールバック。
// どちらの分岐でも dispose() は必ず生える (fallback 側は no-op)。
/** @returns {Promise<IgnorePredicate>} */
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
  // stderr はパイプ詰まりを避けるため常時 drain しつつ末尾だけ保持しておく。
  // fail 時の診断用。暴走出力で RAM を食わないよう上限でクランプする。
  const STDERR_CAP = 4 * 1024
  let stderrTail = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_CAP)
  })

  const queue = []
  const fail = (cause) => {
    const tail = stderrTail.trim()
    // stderr に有用な情報があるときだけ wrap する (無いときは元のエラーをそのまま流す)。
    const err =
      tail && cause instanceof Error
        ? Object.assign(new Error(`${cause.message} (git check-ignore stderr: ${tail})`), {
            cause,
          })
        : cause
    while (queue.length) queue.shift().reject(err)
  }
  readNullRecords(child.stdout, 4, (fields) => {
    // -z --non-matching 時、非一致は source フィールドが空文字
    const matched = fields[0] !== ''
    const waiter = queue.shift()
    if (!waiter) {
      // 1 入力 = 1 レコードの前提 (git check-ignore --verbose --non-matching) が崩れている。
      // silent に捨てると以降の waiter とレコードの対応付けがズレるので、保留中を含め失敗させる。
      fail(new Error('git check-ignore が予期しないレコードを出力しました'))
      return
    }
    waiter.resolve(matched)
  })

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
