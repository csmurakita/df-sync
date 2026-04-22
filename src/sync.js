import { posix } from 'node:path'

export async function sync({ source, destination, mirror, dryRun, ignorePath }) {
  console.log('source を走査...')
  const src = applyIgnore(await source.list(), ignorePath)
  console.log(`  ファイル ${src.files.size} 件 / ディレクトリ ${src.dirs.length} 件`)

  console.log('destination を走査...')
  const dst = applyIgnore(await destination.list(), ignorePath)
  console.log(`  ファイル ${dst.files.size} 件 / ディレクトリ ${dst.dirs.length} 件`)

  const deletePlan = buildDeletePlan(src, dst, {
    mirror,
    recursiveDirDelete: Boolean(destination.supportsRecursiveDirDelete),
  })

  console.log('書き込み対象を判定中 (サイズ比較 → バイト比較)...')
  const { filesToWrite, skipped } = await selectFilesToWrite(source, destination, src, dst)
  console.log(
    `計画: ディレクトリ削除 ${deletePlan.dirs.length} / ファイル削除 ${deletePlan.files.length} / 書き込み ${filesToWrite.length} (内容一致でスキップ ${skipped})`,
  )

  if (dryRun) {
    printDryRun(deletePlan, filesToWrite)
    return
  }

  await execute(destination, source, deletePlan, filesToWrite)
  console.log('同期完了')
}

// mirror が false なら削除対象は空。
// recursiveDirDelete が true なら dst の空でないディレクトリを rmdir で一括削除できる (remote 向け)。
// false の場合は destination 側が ignored ファイル等を巻き込むリスクがあるため
// 列挙済みファイルのみ個別に削除する (local 向け)。
function buildDeletePlan(src, dst, { mirror, recursiveDirDelete }) {
  if (!mirror) return { dirs: [], files: [] }

  const srcFiles = new Set(src.files.keys())
  const srcAncestors = collectAncestorDirs(srcFiles)

  if (recursiveDirDelete) {
    const dirs = minimizeDirs(dst.dirs.filter((d) => !srcAncestors.has(d)))
    const deletedDirSet = new Set(dirs)
    const files = [...dst.files.keys()].filter(
      (f) => !srcFiles.has(f) && !hasAncestorIn(f, deletedDirSet),
    )
    return { dirs, files }
  }

  const files = [...dst.files.keys()].filter((f) => !srcFiles.has(f))
  return { dirs: [], files }
}

async function selectFilesToWrite(source, destination, src, dst) {
  const filesToWrite = []
  let skipped = 0
  for (const [relPath, srcMeta] of src.files) {
    const decision = await classify(source, destination, relPath, srcMeta, dst.files.get(relPath))
    if (decision.write) {
      filesToWrite.push({ relPath, reason: decision.reason })
    } else {
      skipped++
    }
  }
  return { filesToWrite, skipped }
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
  return { write: true, reason: 'content-differs' }
}

function printDryRun(plan, filesToWrite) {
  for (const d of plan.dirs) console.log(`  rmdir ${d}`)
  for (const f of plan.files) console.log(`  rm    ${f}`)
  for (const f of filesToWrite) console.log(`  write ${f.relPath} (${f.reason})`)
}

// Dataform API はワークスペース変更系呼び出しの並列実行を拒否する
// (409 ABORTED: sync mutate calls cannot be queued) ため直列で実行する。
// local destination でも直列を維持 (単純さのため)。
async function execute(destination, source, plan, filesToWrite) {
  for (const dir of plan.dirs) {
    console.log(`  rmdir ${dir}`)
    await destination.removeDirectory(dir)
  }
  for (const path of plan.files) {
    console.log(`  rm ${path}`)
    await destination.removeFile(path)
  }
  for (const file of filesToWrite) {
    console.log(`  write ${file.relPath} (${file.reason})`)
    const bytes = await source.read(file.relPath)
    await destination.write(file.relPath, bytes)
  }
}

// ignore ルール (ローカルの .gitignore と ALWAYS_EXCLUDE) を source/destination 双方に適用する。
// これにより download 時にリモートの ignored パスがローカルに書き込まれることも、
// upload --mirror 時にリモートの ignored パスが削除されることも防ぐ。
function applyIgnore(listing, ignorePath) {
  if (!ignorePath) return listing
  const files = new Map()
  for (const [p, m] of listing.files) {
    if (!ignorePath(p, false)) files.set(p, m)
  }
  const dirs = listing.dirs.filter((d) => !ignorePath(d, true))
  return { files, dirs }
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
