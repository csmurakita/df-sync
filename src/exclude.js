// プロジェクト全体で常時除外するパスルール。local 側列挙時のみ作用する。
// remote 側はリスト/読み出しを一切フィルタしないので、
// - upload: local に存在しないので上がらない
// - download --mirror の削除候補: local 列挙に出てこないので削除されない
// が結果として成立する。
//
// - .git / node_modules : VCS / パッケージキャッシュ
// - .df-credentials.json: Dataform CLI の認証情報。機密なので
//   どの階層にあっても同期対象から外す。
const ALWAYS_EXCLUDE_SEGMENTS = new Set(['.git', 'node_modules', '.df-credentials.json'])

// walk 中のエントリ名単位での判定 (事前除外、recurse 前の枝刈り)。
export function isAlwaysExcludedName(name) {
  return ALWAYS_EXCLUDE_SEGMENTS.has(name)
}

// 完成した相対パス単位での判定 (gitignore 述語が事前チェックに使う)。
export function matchesAlwaysExclude(path) {
  return path.split('/').some((seg) => ALWAYS_EXCLUDE_SEGMENTS.has(seg))
}
