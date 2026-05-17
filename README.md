# Zenn CLI

* [📘 How to use](https://zenn.dev/zenn/articles/zenn-cli-guide)

---

## 経理部門 自動化（`accounting/`）

### 概要

Claude API + Gmail + Notion を活用して、経理業務を自動化します。

- **請求書の自動生成と発番管理**（`npm run invoice`、インボイス対応 PDF）
- **Gmail 送信は `lib/mailer.js` に共通化済み**（経理・営業が共用）

## 自動化の運用

| タイミング | Actions | 内容 |
|---|---|---|
| 毎日 03:00 JST (平日) | `post_x_daily` | X への自動投稿 |
| 毎週日曜 08:00 JST | `weekly_content` | 週次コンテンツ生成 |
| 毎日 09:00 JST | `accounting-payments` | 支払期日リマインダー |
| 毎日 09:00 JST | `sales-morning-reminder` | 営業朝リマインダー |
| 毎日 09:30 JST | `sync-from-sales` | 受注 → 請求書下書き生成 |
| 毎月 5 日 09:00 JST | `accounting-monthly-report` | 月次レポート生成 |
| 毎週月曜 09:00 JST | `accounting-fetch-receipts` | 領収書 Gmail 取り込み |
| **毎年 4 月 1 日 09:00 JST** | `tax-rates-annual-check` | **税制改正年次チェック Issue 自動起票** |

> **Note**: state 書き込みがある Actions (payments / fetch-receipts / sync-from-sales) は
> 実行後に変更を ichi-data リポへ自動コミットします。

## データリポジトリ分離 (ichi-data)

機微情報(顧客名・金額・領収書・パイプライン案件)は **Private リポジトリ `ichi-data`** で管理します。

### ローカル運用

```bash
# 1. ichi-data をクローン (ichi-blog の親ディレクトリへ)
git clone git@github.com:ICHI-hash/ichi-data.git

# 2. ichi-blog/data にシンボリックリンクを作成
cd ichi-blog
ln -s ../ichi-data data     # Mac/Linux
# mklink /D data ..\ichi-data  (Windows 管理者権限)

# 3. .env に追記
# INPUT_BASE_DIR=./data
# STATE_BASE_DIR=./data
# OUTPUT_BASE_DIR=./data
```

### Actions 運用

各スクリプトが実行時に ichi-data を `./data` にチェックアウトし、
state の変更を自動的にコミットします。

| Secret | 用途 |
|---|---|
| `DATA_REPO_FULL_NAME` | `ICHI-hash/ichi-data` |
| `DATA_REPO_TOKEN` | ichi-data に Contents:write 権限を持つ PAT |

### 後方互換

`INPUT_BASE_DIR` 等が未設定の場合は ichi-blog 配下のパスを使用します。
ローカルでの最初のセットアップはこの状態でも動作します。

---

## 部門間連携

| 連携 | 方向 | スクリプト |
|---|---|---|
| 営業 → 経理 | 受注案件 → 請求書下書き自動生成 | `npm run sync-from-sales` |
| 経理 ← Gmail | 領収書メール → inputs/receipts/ 自動取り込み + OCR | `npm run fetch-receipts` |
- **経費の自動仕訳**（`npm run categorize`、AI による勘定科目分類）
- **入金消込の補助**（`npm run reconcile`、Jaro-Winkler + AI スコアリング）
- **月次レポート**（`npm run monthly-report`、推定納税額・Notion 連携）
- **支払予定リマインダー**（`npm run payments`、Gmail 送信・GitHub Actions 対応）
- **税理士向け月次パッケージ**（`npm run tax-package`、ZIP 圧縮・チェックリスト付き）

詳細: [`accounting/README.md`](accounting/README.md)

---

## 営業部門 自動化（`sales/`）

### 概要

Claude API を活用して、営業活動に必要な書類・メールを自動生成します。
毎朝 09:00 JST の要対応リマインダー（`npm run sales:reminder`）も稼働中。
`.env`（リポジトリ直下）に `ANTHROPIC_API_KEY` を設定して使用します。

### 各スクリプトの使い方

```bash
cd sales

npm run proposal   # 提案書 PDF を自動生成
npm run quote      # 見積書 PDF を自動生成
npm run followup   # フォローアップメール（Markdown）を自動生成
```

### 入力ファイルの場所

| スクリプト | 入力ディレクトリ | フォーマット |
|-----------|----------------|------------|
| proposal | `sales/inputs/proposals/` | `*.md`（YAMLフロントマター + 課題・要望本文） |
| quote | `sales/inputs/quotes/` | `*.yml`（顧客情報・明細・税率） |
| followup | `sales/inputs/followups/` | `*.md`（YAMLフロントマター + 商談メモ） |

生成物は `sales/outputs/` 配下に出力されます（`.gitignore` で除外済み）。

### パイプライン管理（Google Sheets）

Google Apps Script による毎日 9:00 JST の要対応リマインダーを提供します。
セットアップ手順: [`sales/pipeline/README.md`](sales/pipeline/README.md)

スプレッドシート URL: <!-- TODO: Google Sheets の URL をここに貼る -->