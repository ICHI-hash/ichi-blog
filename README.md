# Zenn CLI

* [📘 How to use](https://zenn.dev/zenn/articles/zenn-cli-guide)

---

## 経理部門 自動化（`accounting/`）

### 概要

Claude API + Gmail + Notion を活用して、経理業務を自動化します。

- **請求書の自動生成と発番管理**（`npm run invoice`、インボイス対応 PDF）
- **Gmail 送信は `lib/mailer.js` に共通化済み**（経理・営業が共用）

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