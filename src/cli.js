import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import { DataformClient } from './api.js'
import { buildIgnorePredicate } from './gitignore.js'
import { createSides } from './sides.js'
import { sync } from './sync.js'

const CREDENTIALS_FILENAME = '.df-credentials.json'

export async function main() {
  const program = new Command()
    .name('df-sync')
    .description('ローカル / GCP Dataform Workspace 間でファイル同期 (コミットはしない)')

  applyCommonOptions(program.command('upload'))
    .description('ローカル → ワークスペース へ同期')
    .action((opts) => run('upload', opts))

  applyCommonOptions(program.command('download'))
    .description('ワークスペース → ローカル へ同期')
    .action((opts) => run('download', opts))

  await program.parseAsync()
}

function applyCommonOptions(cmd) {
  return cmd
    .requiredOption('-w, --workspace <repository/workspace>', '対象ワークスペース (例: sample/dev)')
    .option('-p, --project <id>', `GCP プロジェクト ID (省略時は ${CREDENTIALS_FILENAME} の projectId)`)
    .option('-l, --location <id>', `ロケーション 例: us-central1 (省略時は ${CREDENTIALS_FILENAME} の location)`)
    .option('-d, --dir <path>', 'ローカルディレクトリ (省略時はカレントディレクトリ)')
    .option('-n, --dry-run', '実行せず計画だけ表示する', false)
    .option('--mirror', '対向に存在しないファイル/ディレクトリを削除する (破壊的)', false)
}

async function run(direction, opts) {
  const localDir = await resolveLocalDir(opts.dir)
  const { project, location } = await resolveProjectAndLocation(opts, localDir)
  const { repository, workspace } = parseWorkspace(opts.workspace)
  const client = new DataformClient({ project, location, repository, workspace })

  const fullIgnore = await buildIgnorePredicate(localDir)
  try {
    const { source, destination } = createSides(direction, { localDir, client, fullIgnore })

    console.log(
      `${direction}: ${direction === 'upload' ? `${localDir} → ${opts.workspace}` : `${opts.workspace} → ${localDir}`}` +
        (opts.mirror ? ' (--mirror)' : ''),
    )

    await sync({
      source,
      destination,
      mirror: Boolean(opts.mirror),
      dryRun: Boolean(opts.dryRun),
    })
  } finally {
    fullIgnore.dispose?.()
  }
}

function parseWorkspace(spec) {
  const parts = spec.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`--workspace は <repository>/<workspace> 形式で指定してください: ${spec}`)
  }
  return { repository: parts[0], workspace: parts[1] }
}

async function resolveLocalDir(dir) {
  const abs = resolve(dir ?? process.cwd())
  const info = await stat(abs).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new Error(`ローカルディレクトリが見つかりません: ${abs}`)
  }
  return abs
}

async function resolveProjectAndLocation(opts, localDir) {
  // 両方揃っていれば .df-credentials.json を開かない (不要な I/O 回避)。
  const credentials =
    opts.project && opts.location ? null : await readCredentials(localDir)
  const project = opts.project ?? credentials?.projectId
  if (!project) {
    throw new Error(`--project が未指定で ${CREDENTIALS_FILENAME} からも解決できませんでした`)
  }
  const location = opts.location ?? credentials?.location
  if (!location) {
    throw new Error(`--location が未指定で ${CREDENTIALS_FILENAME} からも解決できませんでした`)
  }
  return { project, location }
}

async function readCredentials(localDir) {
  const path = join(localDir, CREDENTIALS_FILENAME)
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new Error(`${path} の読み込みに失敗: ${err.message}`)
  }
}
