# Zenn CLI

* [📘 How to use](https://zenn.dev/zenn/articles/zenn-cli-guide)

---

## 営業部門 自動化（`sales/`）

### 概要

Claude API を活用して、営業活動に必要な書類・メールを自動生成します。
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