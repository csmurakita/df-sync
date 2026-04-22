# df-sync

ローカル <-> GCP Dataform Workspace 間でファイル同期する Node.js 製 CLI。
**ファイル同期のみを行い、コミットはしない**。

## 特徴

- `upload` / `download` サブコマンドで双方向に同期可能
- `--mirror` 時のみ対向に存在しないファイル/ディレクトリを削除（既定は書き込みのみの非破壊動作）
- 内容が一致するファイルは書き込みをスキップ
- `.gitignore` に従って同期対象を制御（git 管理下ならネストされた `.gitignore` やグローバル設定にも対応）
- `.df-credentials.json` の `projectId` / `location` を自動フォールバック
- `--dry-run` で計画だけ確認可能

## 前提

- Node.js 20 以上
- GCP の認証設定（以下のいずれか）
  - `gcloud auth application-default login` 済み
  - `GOOGLE_APPLICATION_CREDENTIALS` にサービスアカウントキーのパス
- 認証主体が対象リポジトリに対して `dataform.workspaces.writeFile` などの権限を持つこと
  （例: `roles/dataform.editor` もしくは相当のカスタムロール）
- （任意）PATH に `git` があれば `.gitignore` をより厳密に解釈する（ネスト・グローバル設定等）

## インストール / 実行

グローバルインストールして `df-sync` コマンドとして使う：

```bash
npm install -g github:csmurakita/df-sync
df-sync upload --workspace sample/dev
```

一回限りの実行なら `npx` でも可:

```bash
npx github:csmurakita/df-sync upload --workspace sample/dev
```

## 使い方

```bash
df-sync <upload|download> --workspace <repository>/<workspace> \
  [--project <id>] [--location <id>] \
  [--dir <path>] [--dry-run] [--mirror]
```

| サブコマンド | 方向 |
|---|---|
| `upload` | ローカル → ワークスペース |
| `download` | ワークスペース → ローカル |

### オプション (共通)

| オプション | 必須 | 説明 |
|---|---|---|
| `-w, --workspace <repository>/<workspace>` | ✓ | 対象の Dataform ワークスペース（例: `sample/dev`） |
| `-p, --project <id>` | | GCP プロジェクト ID。省略時はローカルの `.df-credentials.json` の `projectId` |
| `-l, --location <id>` | | ロケーション（例: `asia-northeast1`）。省略時は `.df-credentials.json` の `location` |
| `-d, --dir <path>` | | ローカルディレクトリ。省略時はカレントディレクトリ |
| `-n, --dry-run` | | 実行せず計画のみ表示 |
| `--mirror` | | 対向に存在しないファイル/ディレクトリを削除（**破壊的**、既定無効） |

### 例

最小構成 (upload, 非破壊):

```bash
cd my-dataform-project
df-sync upload --workspace sample/dev
```

mirror 同期 (対向の不要ファイルも削除):

```bash
df-sync upload --workspace sample/dev --mirror
```

ワークスペースの最新状態をローカルに取り込む:

```bash
df-sync download --workspace sample/dev --dir ./my-dataform-project
```

明示指定:

```bash
df-sync upload \
  --project my-gcp-project \
  --location asia-northeast1 \
  --workspace sample/dev \
  --dir ./my-dataform-project
```

## 同期の挙動

`upload` / `download` とも以下のルールで同期する:

- 対向に存在しないファイル → 書き込み
- 内容が一致するファイル → スキップ
- 内容が異なるファイル → 書き込み
- `--mirror` 指定時のみ、source に無い destination のファイル/ディレクトリを削除

コミット（`commit` / `push`）は行わない。`upload` 時の変更はワークスペースの「未コミット状態」として残る。

## 除外ルール

常に除外されるパス（両方向で同期対象外）:

- `.git/`
- `node_modules/`
- `.df-credentials.json`

ローカルの `.gitignore` は以下の場面でのみ適用される:

- `upload` 時の同期対象列挙: ignored ファイルは **アップロードしない**
- `--mirror` 時の削除判定: ignored パスに一致する destination のファイル/ディレクトリは **削除しない**（upload / download 両方向）
- `download` 時の書き込み判定には **影響しない**（リモートに ignored パスのファイルがあれば忠実に取得する）

## 注意

- `--mirror` 指定時は対向の未同期変更が失われる可能性がある。実行前に `--dry-run` で計画を確認すること
- `download` はリモート内容を忠実に反映するため、リモートに `.gitignore` 対象パスのファイル（例: `build/` 配下）があればローカルに書き込まれる（既存のローカル ignored ファイルも上書きされ得る）
- BigQuery/Snowflake 接続情報を含む `.df-credentials.json` は常時除外の対象で、`upload` / `download` いずれでも触らない
- リポジトリ ID / ワークスペース ID はあらかじめ GCP 側で存在している必要がある（この CLI は作成しない）
