// プロジェクト全体で常時除外するパスルール。
// local 側の walk・remote list・ignore 述語のいずれからも参照される。
//
// - .git / node_modules : VCS / パッケージキャッシュ
// - .df-credentials.json: Dataform CLI の認証情報。機密なので
//   どの階層にあっても同期対象から外す。
const ALWAYS_EXCLUDE_SEGMENTS = new Set(['.git', 'node_modules', '.df-credentials.json'])

// walk 中のエントリ名単位での判定 (事前除外、recurse 前の枝刈り)。
export function isAlwaysExcludedName(name) {
  return ALWAYS_EXCLUDE_SEGMENTS.has(name)
}

// 完成した相対パス単位での判定 (ignore 述語 / remote list の事後フィルタ)。
export function matchesAlwaysExclude(path) {
  return path.split('/').some((seg) => ALWAYS_EXCLUDE_SEGMENTS.has(seg))
}

// remote list 結果の事後フィルタ。
// local 側の walk は事前除外なので呼ぶ必要はない。
export function filterAlwaysExcluded({ files, dirs }) {
  const filteredFiles = new Map()
  for (const [p, m] of files) {
    if (!matchesAlwaysExclude(p)) filteredFiles.set(p, m)
  }
  return { files: filteredFiles, dirs: dirs.filter((d) => !matchesAlwaysExclude(d)) }
}
