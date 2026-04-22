import { posix } from 'node:path'
import { runWithLimit } from './concurrency.js'

/**
 * @typedef {{ sizeBytes: number | null }} FileMeta
 *
 * @typedef {{ files: Map<string, FileMeta>, dirs: string[] }} Listing
 *
 * @typedef {(relPath: string, isDir: boolean) => boolean | Promise<boolean>} SkipPredicate
 *
 * sync が source / destination として扱う最小インターフェイス。
 * `localSide` / `remoteSide` (src/sides.js) が実装する。
 *
 * @typedef {Object} Side
 * @property {boolean} supportsRecursiveDirDelete - true なら removeDirectory が再帰的に削除する
 * @property {SkipPredicate | null} shouldSkipDelete - --mirror 削除時にスキップ判定する述語 (任意、download 側 destination でのみ使用)
 * @property {((relPath: string) => boolean) | null} shouldSkipWrite - 書き込み計画から除外するパス判定 (任意、destination=local が ALWAYS_EXCLUDE を弾くために使う)
 * @property {() => Promise<Listing>} list
 * @property {(relPath: string) => Promise<Buffer>} read
 * @property {(relPath: string, bytes: Buffer) => Promise<unknown>} write
 * @property {(relPath: string) => Promise<unknown>} removeFile
 * @property {(relPath: string) => Promise<unknown>} removeDirectory
 */

// サイズ一致時のバイト比較で read が重くなるため、ファイル間を並列度制限付きで回す。
// 書き込み判定は source / destination 両方の listing が既に必要なフィルタ
// (ALWAYS_EXCLUDE など) を適用済みである前提で、内容比較のみを行う。
const CLASSIFY_CONCURRENCY = 8

// shouldSkipDelete は git check-ignore への async 問い合わせになり得るので
// 削除候補が大量にあるときのバックログを抑える。
const SKIP_DELETE_CONCURRENCY = 16

export async function sync({ source, destination, mirror, dryRun, log = defaultLog }) {
  log('source / destination を走査...')
  const [src, dst] = await Promise.all([source.list(), destination.list()])
  log(`  source:      ファイル ${src.files.size} 件 / ディレクトリ ${src.dirs.length} 件`)
  log(`  destination: ファイル ${dst.files.size} 件 / ディレクトリ ${dst.dirs.length} 件`)

  log('書き込み対象を判定中 (サイズ比較 → バイト比較)...')
  const { filesToWrite, skipped } = await selectFilesToWrite(source, destination, src, dst)

  const deletePlan = await buildDeletePlan(src, dst, {
    mirror,
    recursiveDirDelete: Boolean(destination.supportsRecursiveDirDelete),
    shouldSkipDelete: destination.shouldSkipDelete,
  })

  const actions = buildActions(deletePlan, filesToWrite)
  log(
    `計画: ディレクトリ削除 ${deletePlan.dirs.length} / ファイル削除 ${deletePlan.files.length} / 書き込み ${filesToWrite.length} (スキップ ${skipped})`,
  )

  // Dataform API はワークスペース変更系呼び出しの並列実行を拒否する
  // (409 ABORTED: sync mutate calls cannot be queued) ため直列で実行する。
  // local destination でも直列を維持 (単純さのため)。
  for (const action of actions) {
    log(formatAction(action))
    if (!dryRun) await applyAction(action, source, destination)
  }
  if (!dryRun) log('同期完了')
}

function defaultLog(...args) {
  console.log(...args)
}

async function selectFilesToWrite(source, destination, src, dst) {
  // destination が拒否するパス (download 側 local の ALWAYS_EXCLUDE 等) は
  // classify する前に落とす — 余計な source.read / destination.read を発行しない。
  const skipWrite = destination.shouldSkipWrite
  const entries = skipWrite ? [...src.files].filter(([p]) => !skipWrite(p)) : [...src.files]
  const classified = await runWithLimit(
    entries,
    CLASSIFY_CONCURRENCY,
    async ([relPath, srcMeta]) => {
      const decision = await classify(source, destination, relPath, srcMeta, dst.files.get(relPath))
      // content-differs 時に decision.bytes を保持しておくことで execute の書き込みで
      // source.read を 2 回発行するのを避ける。
      return decision ? { relPath, ...decision } : null
    },
  )
  const filesToWrite = classified.filter(Boolean)
  return { filesToWrite, skipped: classified.length - filesToWrite.length }
}

// 書き込み不要なら null、書き込みが必要なら { reason, bytes? } を返す。
async function classify(source, destination, relPath, srcMeta, dstMeta) {
  if (!dstMeta) return { reason: 'new' }
  // sizeBytes は remote API が稀に欠落 (null) させる。両方 null の場合だけは
  // null !== null === false で size-differs に倒れず、後段のバイト比較に進む。
  // 片方だけ null なら不一致扱いで write させる (誤判定でもデータ損失より安全側)。
  if (srcMeta.sizeBytes !== dstMeta.sizeBytes) return { reason: 'size-differs' }
  const [srcBytes, dstBytes] = await Promise.all([
    source.read(relPath),
    destination.read(relPath),
  ])
  if (srcBytes.equals(dstBytes)) return null
  return { reason: 'content-differs', bytes: srcBytes }
}

// mirror が false なら削除対象は空。
// recursiveDirDelete が true なら dst のディレクトリを rmdir 一括削除できる (remote 向け)。
// false の場合は列挙済みファイルのみ個別削除する (local 向け)。
// shouldSkipDelete が指定されていれば、それに一致するパスは削除候補から外す
// (download 側 destination=local で .gitignore 対象の局所ファイルを保護する用途)。
// upload 側 destination=remote では shouldSkipDelete=null で渡されるため、
// local に無い remote のものは ALWAYS_EXCLUDE 以外すべて削除候補となる。
async function buildDeletePlan(src, dst, { mirror, recursiveDirDelete, shouldSkipDelete }) {
  if (!mirror) return { dirs: [], files: [] }

  const srcFiles = new Set(src.files.keys())
  const srcAncestors = collectAncestorDirs(srcFiles)

  let candidateFiles = [...dst.files.keys()].filter((f) => !srcFiles.has(f))
  let candidateDirs = dst.dirs.filter((d) => !srcAncestors.has(d))

  if (shouldSkipDelete) {
    // files と dirs を 1 本の runWithLimit に束ねて、並列度 SKIP_DELETE_CONCURRENCY を
    // 全削除候補で共有する (git check-ignore 呼び出しが 2 波に分かれるのを防ぐ)。
    const items = [
      ...candidateFiles.map((path) => ({ path, isDir: false })),
      ...candidateDirs.map((path) => ({ path, isDir: true })),
    ]
    const skips = await runWithLimit(items, SKIP_DELETE_CONCURRENCY, ({ path, isDir }) =>
      shouldSkipDelete(path, isDir),
    )
    const kept = items.filter((_, i) => !skips[i])
    candidateFiles = kept.filter((x) => !x.isDir).map((x) => x.path)
    candidateDirs = kept.filter((x) => x.isDir).map((x) => x.path)
  }

  if (recursiveDirDelete) {
    const dirs = minimizeDirs(candidateDirs)
    const deletedDirSet = new Set(dirs)
    const files = candidateFiles.filter((f) => !hasAncestorIn(f, deletedDirSet))
    return { dirs, files }
  }

  return { dirs: [], files: candidateFiles }
}

// deletePlan と filesToWrite を rmdir → rm → write の単一アクション列に整える。
// dryRun / 本番のログ出力と実行はどちらもこの列を順に処理する。
function buildActions(deletePlan, filesToWrite) {
  const actions = []
  for (const relPath of deletePlan.dirs) actions.push({ kind: 'rmdir', relPath })
  for (const relPath of deletePlan.files) actions.push({ kind: 'rm', relPath })
  for (const { relPath, reason, bytes } of filesToWrite) {
    actions.push({ kind: 'write', relPath, reason, bytes })
  }
  return actions
}

function formatAction(action) {
  switch (action.kind) {
    case 'rmdir':
      return `  rmdir ${action.relPath}`
    case 'rm':
      return `  rm    ${action.relPath}`
    case 'write':
      return `  write ${action.relPath} (${action.reason})`
  }
}

async function applyAction(action, source, destination) {
  switch (action.kind) {
    case 'rmdir':
      return destination.removeDirectory(action.relPath)
    case 'rm':
      return destination.removeFile(action.relPath)
    case 'write': {
      // classify が content-differs 時に読み込んだ bytes はここで使い回す (二重 read 回避)。
      const bytes = action.bytes ?? (await source.read(action.relPath))
      return destination.write(action.relPath, bytes)
    }
  }
}

function collectAncestorDirs(relPaths) {
  const dirs = new Set()
  for (const p of relPaths) {
    let d = posix.dirname(p)
    while (d && d !== '.') {
      dirs.add(d)
      d = posix.dirname(d)
    }
  }
  return dirs
}

function minimizeDirs(dirs) {
  const set = new Set(dirs)
  return dirs.filter((d) => {
    let parent = posix.dirname(d)
    while (parent && parent !== '.') {
      if (set.has(parent)) return false
      parent = posix.dirname(parent)
    }
    return true
  })
}

function hasAncestorIn(filePath, dirSet) {
  let parent = posix.dirname(filePath)
  while (parent && parent !== '.') {
    if (dirSet.has(parent)) return true
    parent = posix.dirname(parent)
  }
  return false
}
