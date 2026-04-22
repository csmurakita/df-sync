# df-sync

ローカルの Dataform プロジェクトを GCP Dataform Workspace にミラー同期する Node.js 製 CLI。
**ファイル同期のみを行い、コミットはしない**。

## 特徴

- ローカルディレクトリの内容でワークスペースを上書きするミラー同期（ローカルに無いファイル/ディレクトリは削除）
- 内容が一致するファイルは書き込みをスキップ（ファイルサイズ → バイト比較の 2 段階判定）
- `.gitignore` を尊重し、`.git` / `node_modules` / `.df-credentials.json` は常に除外
- `.df-credentials.json` の `projectId` / `location` を自動フォールバック
- `--dry-run` で計画だけ確認可能

## 前提

- Node.js 20 以上
- GCP の認証設定（以下のいずれか）
  - `gcloud auth application-default login` 済み
  - `GOOGLE_APPLICATION_CREDENTIALS` にサービスアカウントキーのパス
- 認証主体が対象リポジトリに対して `dataform.workspaces.writeFile` などの権限を持つこと
  （例: `roles/dataform.editor` もしくは相当のカスタムロール）

## インストール / 実行

グローバルインストールして `df-sync` コマンドとして使う：

```bash
npm install -g github:csmurakita/df-sync
df-sync --workspace sample/dev
```

一回限りの実行なら `npx` でも可:

```bash
npx github:csmurakita/df-sync --workspace sample/dev
```

## 使い方

```bash
df-sync --workspace <repository>/<workspace> \
  [--project <id>] [--location <id>] \
  [--dir <path>] [--dry-run]
```

### オプション

| オプション | 必須 | 説明 |
|---|---|---|
| `-w, --workspace <repository>/<workspace>` | ✓ | 同期先の Dataform ワークスペース（例: `sample/dev`） |
| `-p, --project <id>` | | GCP プロジェクト ID。省略時は同期元の `.df-credentials.json` の `projectId` |
| `-l, --location <id>` | | ロケーション（例: `asia-northeast1`）。省略時は `.df-credentials.json` の `location` |
| `-d, --dir <path>` | | 同期元ディレクトリ。省略時はカレントディレクトリ |
| `-n, --dry-run` | | 実行せず計画のみ表示 |

### 例

最小構成（`.df-credentials.json` から project / location を解決）:

```bash
cd my-dataform-project
df-sync --workspace sample/dev
```

明示指定:

```bash
df-sync \
  --project my-gcp-project \
  --location asia-northeast1 \
  --workspace sample/dev \
  --dir ./my-dataform-project
```

## 同期の挙動

1. ローカルファイルを列挙（`.gitignore` と常時除外ルールを適用）
2. ワークスペースの現状を `queryDirectoryContents`（`view=DIRECTORY_CONTENTS_VIEW_METADATA`）で再帰的に取得。各ファイルのサイズも同時に取得
3. 各ローカルファイルをリモートと照合して書き込み判定
   - リモートに存在しない → 書き込み
   - サイズが異なる → 書き込み
   - サイズ一致 → `readFile` でリモート内容を取得し、ローカルとバイト比較。一致ならスキップ、不一致なら書き込み
4. 計画を構築
   - ローカルに存在しないリモートディレクトリを削除（親子で重複する場合は親のみ）
   - ローカルに存在しないリモートファイルを削除（削除対象ディレクトリ配下のファイルはスキップ）
   - 判定で「書き込み」となったファイルのみ `writeFile` で上書き
5. Dataform API が並列の変更呼び出しを許さないため、すべて**直列**で実行

コミット（`commit` / `push`）は行わない。変更はワークスペースの「未コミット状態」として残る。

## 除外ルール

常に除外されるもの（`.gitignore` に無くても対象外）:

- `.git/`
- `node_modules/`
- `.df-credentials.json`

同期元ディレクトリ直下の `.gitignore` があれば追加で適用される。

## 注意

- **ミラー同期**なのでワークスペース側の未同期の変更は失われる。不安なら先に `--dry-run` で計画を確認すること
- BigQuery/Snowflake 接続情報を含む `.df-credentials.json` はアップロードされない（除外対象）
- リポジトリ ID / ワークスペース ID はあらかじめ GCP 側で存在している必要がある（この CLI は作成しない）
