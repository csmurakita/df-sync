import { posix } from 'node:path'

// サイズ一致時のバイト比較で read が重くなるため、ファイル間を並列度制限付きで回す。
// 書き込み判定は source / destination 両方の listing が既に必要なフィルタ
// (ALWAYS_EXCLUDE など) を適用済みである前提で、内容比較のみを行う。
const CLASSIFY_CONCURRENCY = 8

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

  log(
    `計画: ディレクトリ削除 ${deletePlan.dirs.length} / ファイル削除 ${deletePlan.files.length} / 書き込み ${filesToWrite.length} (スキップ ${skipped})`,
  )

  if (dryRun) {
    printDryRun(deletePlan, filesToWrite, log)
    return
  }

  await execute(destination, source, deletePlan, filesToWrite, log)
  log('同期完了')
}

function defaultLog(...args) {
  console.log(...args)
}

async function selectFilesToWrite(source, destination, src, dst) {
  const entries = [...src.files]
  const classified = await runWithLimit(
    entries,
    CLASSIFY_CONCURRENCY,
    async ([relPath, srcMeta]) => {
      const decision = await classify(source, destination, relPath, srcMeta, dst.files.get(relPath))
      if (!decision.write) return null
      // content-differs 時の srcBytes は execute で書き込み時に使い回し、二重 read を避ける。
      return { relPath, reason: decision.reason, bytes: decision.bytes }
    },
  )
  const filesToWrite = classified.filter(Boolean)
  return { filesToWrite, skipped: classified.length - filesToWrite.length }
}

async function classify(source, destination, relPath, srcMeta, dstMeta) {
  if (!dstMeta) return { write: true, reason: 'new' }
  if (srcMeta.sizeBytes !== dstMeta.sizeBytes) {
    return { write: true, reason: 'size-differs' }
  }
  const [srcBytes, dstBytes] = await Promise.all([
    source.read(relPath),
    destination.read(relPath),
  ])
  if (srcBytes.equals(dstBytes)) return { write: false }
  return { write: true, reason: 'content-differs', bytes: srcBytes }
}

// 並列度制限付き map。結果は入力順で返る。
async function runWithLimit(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await task(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return results
}

// mirror が false なら削除対象は空。
// recursiveDirDelete が true なら dst のディレクトリを rmdir 一括削除できる (remote 向け)。
// false の場合は列挙済みファイルのみ個別削除する (local 向け)。
// shouldSkipDelete で守られたパスは削除候補から外す
// (ローカルの .gitignore / ALWAYS_EXCLUDE 対象を両方向のミラー削除から保護する用途)。
async function buildDeletePlan(src, dst, { mirror, recursiveDirDelete, shouldSkipDelete }) {
  if (!mirror) return { dirs: [], files: [] }

  const srcFiles = new Set(src.files.keys())
  const srcAncestors = collectAncestorDirs(srcFiles)

  let candidateFiles = [...dst.files.keys()].filter((f) => !srcFiles.has(f))
  let candidateDirs = dst.dirs.filter((d) => !srcAncestors.has(d))

  if (shouldSkipDelete) {
    const fileSkips = await Promise.all(candidateFiles.map((f) => shouldSkipDelete(f, false)))
    candidateFiles = candidateFiles.filter((_, i) => !fileSkips[i])
    const dirSkips = await Promise.all(candidateDirs.map((d) => shouldSkipDelete(d, true)))
    candidateDirs = candidateDirs.filter((_, i) => !dirSkips[i])
  }

  if (recursiveDirDelete) {
    const dirs = minimizeDirs(candidateDirs)
    const deletedDirSet = new Set(dirs)
    const files = candidateFiles.filter((f) => !hasAncestorIn(f, deletedDirSet))
    return { dirs, files }
  }

  return { dirs: [], files: candidateFiles }
}

function printDryRun(plan, filesToWrite, log) {
  for (const d of plan.dirs) log(`  rmdir ${d}`)
  for (const f of plan.files) log(`  rm    ${f}`)
  for (const f of filesToWrite) log(`  write ${f.relPath} (${f.reason})`)
}

// Dataform API はワークスペース変更系呼び出しの並列実行を拒否する
// (409 ABORTED: sync mutate calls cannot be queued) ため直列で実行する。
// local destination でも直列を維持 (単純さのため)。
async function execute(destination, source, plan, filesToWrite, log) {
  for (const dir of plan.dirs) {
    log(`  rmdir ${dir}`)
    await destination.removeDirectory(dir)
  }
  for (const path of plan.files) {
    log(`  rm ${path}`)
    await destination.removeFile(path)
  }
  for (const file of filesToWrite) {
    log(`  write ${file.relPath} (${file.reason})`)
    const bytes = file.bytes ?? (await source.read(file.relPath))
    await destination.write(file.relPath, bytes)
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
