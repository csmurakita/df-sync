import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import { DataformClient, remoteSide } from './api.js'
import { buildIgnorePredicate } from './gitignore.js'
import { localSide } from './local.js'
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
    const { source, destination } = buildSides(direction, { localDir, client, fullIgnore })

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

// 方向別の source / destination 構成:
//  upload   : source=local (full ignore で列挙),   destination=remote (mirror 削除時のみ local ignore で保護)
//  download : source=remote (ALWAYS_EXCLUDE のみ), destination=local  (ALWAYS_EXCLUDE のみで列挙し remote 内容を忠実に反映、mirror 削除時は local ignore で保護)
function buildSides(direction, { localDir, client, fullIgnore }) {
  if (direction === 'upload') {
    return {
      source: localSide(localDir, { listFilter: fullIgnore }),
      destination: remoteSide(client, { shouldSkipDelete: fullIgnore }),
    }
  }
  return {
    source: remoteSide(client),
    destination: localSide(localDir, { shouldSkipDelete: fullIgnore }),
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
  if (opts.project && opts.location) {
    return { project: opts.project, location: opts.location }
  }
  const credentials = await readCredentials(localDir)
  const project = assertConfig(
    opts.project ?? credentials?.projectId,
    `--project が未指定で ${CREDENTIALS_FILENAME} からも解決できませんでした`,
  )
  const location = assertConfig(
    opts.location ?? credentials?.location,
    `--location が未指定で ${CREDENTIALS_FILENAME} からも解決できませんでした`,
  )
  return { project, location }
}

function assertConfig(value, message) {
  if (!value) throw new Error(message)
  return value
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
