# df-sync

ローカル <-> GCP Dataform Workspace 間でファイル同期する Node.js 製 CLI。
**ファイル同期のみを行い、コミットはしない**。

## 特徴

- `upload` / `download` サブコマンドで双方向に同期可能
- `--mirror` 時のみ対向に存在しないファイル/ディレクトリを削除（既定は書き込みのみの非破壊動作）
- 内容が一致するファイルは書き込みをスキップ（ファイルサイズ → バイト比較の 2 段階判定）
- `.git` / `node_modules` / `.df-credentials.json` は両方向で常に除外
- ローカルの `.gitignore` は以下の場面でのみ使用:
  - `upload` 時の source 列挙（ignored ファイルを「上げない」）
  - `--mirror` 時の削除判定（ignored パスに一致する destination のファイル/ディレクトリを「削除しない」、これは upload/download 両方向に適用）
  - `download` 時の書き込み判定には **関与しない** ので、リモートに `.gitignore` 対象パスのファイルがあれば忠実に取得する
- ローカルディレクトリが git 管理下なら `git check-ignore` を使用し、ネストされた `.gitignore` やグローバル設定も尊重する（git 不在時は root 直下の `.gitignore` にフォールバック）
- `.df-credentials.json` の `projectId` / `location` を自動フォールバック
- `--dry-run` で計画だけ確認可能

## 前提

- Node.js 20 以上
- GCP の認証設定（以下のいずれか）
  - `gcloud auth application-default login` 済み
  - `GOOGLE_APPLICATION_CREDENTIALS` にサービスアカウントキーのパス
- 認証主体が対象リポジトリに対して `dataform.workspaces.writeFile` などの権限を持つこと
  （例: `roles/dataform.editor` もしくは相当のカスタムロール）
- （任意）`git` コマンドが PATH にあれば `git check-ignore` を用いたより正確な無視判定が有効になる。無くても root の `.gitignore` を見る簡易実装で動作する

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

upload / download とも共通の流れ:

1. source / destination 両方をサイズ付きで列挙
   - source が local (upload): `.gitignore` + 常時除外ルールを適用し、`stat` でサイズ取得
   - source が remote (download): `queryDirectoryContents`（`view=DIRECTORY_CONTENTS_VIEW_METADATA`）で再帰取得し、常時除外ルールのみフィルタ
   - destination が local (download): 常時除外ルールのみ適用し `stat` でサイズ取得（ignored ファイルも列挙して比較対象に含める＝リモート内容を忠実に反映）
   - destination が remote (upload): `queryDirectoryContents` で取得し、常時除外ルールのみフィルタ
2. 各 source ファイルを destination と照合して書き込み判定
   - destination に存在しない → 書き込み
   - サイズが異なる → 書き込み
   - サイズ一致 → destination から内容を取得し、source とバイト比較。一致ならスキップ、不一致なら書き込み
3. `--mirror` 指定時のみ、source に無い destination のファイル/ディレクトリを削除対象に含める
   - upload: remote 側のディレクトリは `removeDirectory` で一括削除（親子で重複する場合は親のみ）
   - download: local 側は列挙済みファイルを個別 `unlink`（`.gitignore` 済みファイルを巻き込まないため、再帰削除は行わない）
   - **ローカルの `.gitignore` / 常時除外ルールに一致するパスは削除候補から除外**する。これは upload/download 両方向に適用され、ローカルで除外している対象が相手側に存在しても削除されない
4. Dataform API が並列の変更呼び出しを許さないため、すべて**直列**で実行

コミット（`commit` / `push`）は行わない。upload 時の変更はワークスペースの「未コミット状態」として残る。

## 除外ルール

常に除外されるもの（`.gitignore` に無くても対象外）:

- `.git/`
- `node_modules/`
- `.df-credentials.json`

同期元ディレクトリ直下の `.gitignore` があれば追加で適用される。

## 注意

- `--mirror` 指定時は対向の未同期変更が失われる可能性がある。実行前に `--dry-run` で計画を確認すること
- BigQuery/Snowflake 接続情報を含む `.df-credentials.json` は常時除外の対象なので、upload / download いずれでも触らない（リモートに存在しても download で上書きされない、`--mirror` でも削除されない）
- `download` はリモート内容を忠実に反映するため、リモートに `.gitignore` 対象パスのファイル（例: `build/` 配下）があればローカルに書き込まれる（既存のローカル ignored ファイルも上書きされ得る）。意図しない上書きを避けたい場合は事前に `--dry-run` で計画を確認すること
- リポジトリ ID / ワークスペース ID はあらかじめ GCP 側で存在している必要がある（この CLI は作成しない）
