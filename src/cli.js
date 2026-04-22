import { readFile, stat } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import { Command } from 'commander'
import { DataformClient } from './api.js'
import { enumerateLocal } from './local.js'

const CREDENTIALS_FILENAME = '.df-credentials.json'

export async function main() {
  const opts = parseArgs()
  const sourceDir = await resolveSourceDir(opts.dir)
  const { project, location } = await resolveProjectAndLocation(opts, sourceDir)
  const { repository, workspace } = parseWorkspace(opts.workspace)
  const client = new DataformClient({ project, location, repository, workspace })

  console.log(`ローカルファイルを収集: ${sourceDir}`)
  const localFiles = await enumerateLocal(sourceDir)
  console.log(`  ${localFiles.length} 件`)

  console.log('リモートワークスペースを走査...')
  const remote = await client.listAll()
  console.log(`  ファイル ${remote.files.size} 件 / ディレクトリ ${remote.dirs.length} 件`)

  const plan = buildPlan(localFiles, remote)

  console.log('書き込み対象を判定中 (サイズ比較 → バイト比較)...')
  const { filesToWrite, skipped } = await selectFilesToWrite(client, localFiles, remote.files)
  console.log(
    `計画: ディレクトリ削除 ${plan.dirsToDelete.length} / ファイル削除 ${plan.filesToDelete.length} / 書き込み ${filesToWrite.length} (内容一致でスキップ ${skipped})`,
  )

  if (opts.dryRun) {
    printDryRun(plan, filesToWrite)
    return
  }

  await executePlan(client, plan, filesToWrite)
  console.log('同期完了')
}

function parseArgs() {
  const program = new Command()
  program
    .name('df-sync')
    .description('カレントディレクトリを GCP Dataform Workspace にミラー同期する（コミットはしない）')
    .option('-p, --project <id>', `GCP プロジェクト ID (省略時は ${CREDENTIALS_FILENAME} の projectId)`)
    .option('-l, --location <id>', `ロケーション 例: us-central1 (省略時は ${CREDENTIALS_FILENAME} の location)`)
    .requiredOption('-w, --workspace <repository/workspace>', '同期先ワークスペース (例: sample/dev)')
    .option('-d, --dir <path>', '同期元ディレクトリ (省略時はカレントディレクトリ)')
    .option('-n, --dry-run', '実行せず計画だけ表示する', false)
    .parse()

  const o = program.opts()
  return {
    project: o.project,
    location: o.location,
    workspace: o.workspace,
    dir: o.dir,
    dryRun: Boolean(o.dryRun),
  }
}

function parseWorkspace(spec) {
  const parts = spec.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`--workspace は <repository>/<workspace> 形式で指定してください: ${spec}`)
  }
  return { repository: parts[0], workspace: parts[1] }
}

async function resolveSourceDir(dir) {
  const abs = resolve(dir ?? process.cwd())
  const info = await stat(abs).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new Error(`同期元ディレクトリが見つかりません: ${abs}`)
  }
  return abs
}

async function resolveProjectAndLocation(opts, sourceDir) {
  if (opts.project && opts.location) {
    return { project: opts.project, location: opts.location }
  }
  const credentials = await readCredentials(sourceDir)
  const project = opts.project ?? credentials?.projectId
  const location = opts.location ?? credentials?.location
  if (!project) throw new Error(`--project が未指定で ${CREDENTIALS_FILENAME} からも解決できませんでした`)
  if (!location) throw new Error(`--location が未指定で ${CREDENTIALS_FILENAME} からも解決できませんでした`)
  return { project, location }
}

async function readCredentials(sourceDir) {
  const path = join(sourceDir, CREDENTIALS_FILENAME)
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new Error(`${path} の読み込みに失敗: ${err.message}`)
  }
}

function buildPlan(localFiles, remote) {
  const localFilePaths = new Set(localFiles.map((f) => f.relPath))
  const localDirPaths = collectAncestorDirs(localFiles.map((f) => f.relPath))

  const dirsToDelete = minimizeDirs(remote.dirs.filter((d) => !localDirPaths.has(d)))
  const deletedDirSet = new Set(dirsToDelete)
  const filesToDelete = [...remote.files.keys()].filter(
    (f) => !localFilePaths.has(f) && !hasAncestorIn(f, deletedDirSet),
  )
  return { dirsToDelete, filesToDelete }
}

// ローカルとリモートの内容が一致するファイルは書き込み対象から外す。
// 1) サイズが違えば書き込み 2) 同じなら両方の中身をバイト比較して判定。
// Buffer は判定後に破棄し、実行時に再度ローカルから読み込む。
async function selectFilesToWrite(client, localFiles, remoteFiles) {
  const filesToWrite = []
  let skipped = 0
  for (const file of localFiles) {
    const decision = await classifyFile(client, file, remoteFiles.get(file.relPath))
    if (decision.write) {
      filesToWrite.push({ ...file, reason: decision.reason })
    } else {
      skipped++
    }
  }
  return { filesToWrite, skipped }
}

async function classifyFile(client, file, remoteMeta) {
  if (!remoteMeta) return { write: true, reason: 'new' }

  const { size: localSize } = await stat(file.absPath)
  if (remoteMeta.sizeBytes !== localSize) {
    return { write: true, reason: 'size-differs' }
  }

  const [localBytes, remoteBytes] = await Promise.all([
    readFile(file.absPath),
    client.readFile(file.relPath),
  ])
  if (localBytes.equals(remoteBytes)) return { write: false }
  return { write: true, reason: 'content-differs' }
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

// 親ディレクトリも削除対象に含まれている場合、子は不要なので除外する
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

function printDryRun(plan, filesToWrite) {
  for (const d of plan.dirsToDelete) console.log(`  rmdir ${d}`)
  for (const f of plan.filesToDelete) console.log(`  rm    ${f}`)
  for (const f of filesToWrite) console.log(`  write ${f.relPath} (${f.reason})`)
}

// Dataform API はワークスペース変更系呼び出しの並列実行を拒否する
// (409 ABORTED: sync mutate calls cannot be queued) ため直列で実行する
async function executePlan(client, plan, filesToWrite) {
  for (const dir of plan.dirsToDelete) {
    console.log(`  rmdir ${dir}`)
    await client.removeDirectory(dir)
  }
  for (const path of plan.filesToDelete) {
    console.log(`  rm ${path}`)
    await client.removeFile(path)
  }
  for (const file of filesToWrite) {
    console.log(`  write ${file.relPath} (${file.reason})`)
    const contents = await readFile(file.absPath)
    await client.writeFile(file.relPath, contents)
  }
}
