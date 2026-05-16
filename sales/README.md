# ICHI 営業部門 自動化

## 概要

- 提案書・見積書・フォローアップメールを Claude API で自動生成
- パイプライン管理 (Google Sheets + Apps Script 連携 or ローカル Markdown)
- **毎朝 09:00 JST の要対応リマインダーを Gmail で送信** (`npm run sales:reminder`)

## ディレクトリ構成

```
sales/
├── lib/
│   ├── claude.js          ← Claude API ラッパー
│   └── mailer.js          ← lib/mailer.js (リポジトリ直下) への ESM ラッパー
├── scripts/
│   └── morning-reminder.js ← 朝リマインダー (新規)
├── templates/
│   └── pipeline.example.md ← パイプライン Markdown テンプレ
├── inputs/
│   └── pipeline/          ← パイプライン .md ファイル (gitignore)
└── README.md
```

## 使い方

### 既存スクリプト (sales/ 内で実行)

```bash
cd sales
npm run proposal   # 提案書 PDF
npm run quote      # 見積書 PDF
npm run followup   # フォローアップメール (Markdown)
```

### 朝リマインダー (リポジトリ直下から)

```bash
# プレビュー(何も送信しない)
npm run sales:reminder -- --dry-run

# メール送信なしで確認
npm run sales:reminder -- --no-mail

# 本番実行
npm run sales:reminder
```

## パイプライン案件の登録

### Google Sheets 連携 (SALES_SHEET_ID が設定されている場合)

`.env` に `SALES_SHEET_ID` を設定すると Google Sheets から自動読み込み。
シート A〜F 列: project_name, client_name, stage, next_action, next_action_due, owner_note

### ローカル Markdown (フォールバック)

`SALES_SHEET_ID` が未設定の場合は `sales/inputs/pipeline/*.md` を読む。

```bash
cp sales/templates/pipeline.example.md \
   sales/inputs/pipeline/client-project.md
# (frontmatter を編集)
npm run sales:reminder -- --dry-run
```

`next_action_due` が今日以前 → 期日超過/本日対応としてリマインドされる。

## 環境変数

| 変数名 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API (全スクリプト共通) |
| `GMAIL_CLIENT_ID` | Gmail API OAuth2 |
| `GMAIL_CLIENT_SECRET` | Gmail API OAuth2 |
| `GMAIL_REFRESH_TOKEN` | Gmail API OAuth2 |
| `GMAIL_USER` | 送信元アドレス |
| `BUSINESS_NOTIFY_EMAIL` | リマインダー送信先 |
| `SALES_SHEET_ID` | Google Sheets ID (任意) |

## 経理連携

### stage: 受注 → 請求書下書き自動生成

パイプライン Markdown の `stage` を `受注` に変更すると、
`npm run sync-from-sales` が経理の請求書下書きを自動生成します。

```yaml
# sales/inputs/pipeline/sample.md
stage: 受注   # ← 受注時に変更
billing:
  amount: 300000            # 税抜金額(必須 or needs_review)
  tax_rate: 10
  payment_terms: 月末締め翌月末払い
  items:
    - name: サービス名
      qty: 1
      unit_price: 300000
      tax_rate: 10
```

`billing` セクションが空でも動作します (AI が品目名を補完、金額は人が入力)。

詳細なフィールド説明は `sales/templates/pipeline.example.md` を参照。

### Google Sheets を使う場合の列構造

A〜F列: `project_name, client_name, stage, next_action, next_action_due, owner_note`
G〜M列: `billing_amount, billing_tax_rate, billing_payment_terms, billing_due_offset_days, billing_items_json, billing_client_address, billing_withholding`

G列以降はオプション。未設定なら `needs_review=true` の下書きが生成されます。

---

## Gmail 実装について

メール送信の本体実装は `lib/mailer.js` (リポジトリ直下) にあります。
`sales/lib/mailer.js` は ESM から CJS を利用するための薄いラッパーです。

## GitHub Actions

`.github/workflows/sales-morning-reminder.yml` が毎朝 UTC 00:00 (JST 09:00) に
`npm run sales:reminder` を実行します。

`sales/inputs/pipeline/` は gitignore のため Actions 環境にはファイルが存在しません。
`SALES_SHEET_ID` を設定して Sheets 連携することで実用的な運用が可能です。
