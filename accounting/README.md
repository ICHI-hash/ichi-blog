# ICHI 経理部門 (accounting/)

経理業務(請求書発行・銀行消込・AI 仕訳・月次レポート・支払管理・税理士パッケージ)を
**Claude API + Notion** で自動化するスクリプト群。

> ⚠️ **全スクリプトの出力は AI 補助による生成物です。**
> **税務申告・確定申告の最終判断は必ず人(または税理士)が行ってください。**

---

## 目的とスコープ

- **目的**: 個人事業主・少人数チームが経理業務に費やす時間を削減し、記録の正確性を高める
- **対象**: 請求書発行・入金消込・経費仕訳・月次集計・支払予定管理・税理士提出書類
- **税理士業務は置き換えない**: 本システムは補助ツール。税務判断・申告作業を自動化するものではない

## スコープ外

- 確定申告・青色申告書類の自動作成
- 給与計算・社会保険手続き
- 複式簿記の完全自動化(科目割り当ては AI 補助 + 人確認が前提)
- 法人税・消費税申告

---

## 必要な環境変数 (`.env`)

リポジトリ直下の `.env` に設定する。`.env.example` を参照。

| 変数名 | 必須 | 用途 |
|---|---|---|
| `ANTHROPIC_API_KEY` | **必須** | Claude API(全スクリプト共通) |
| `BUSINESS_NAME` | 請求書時 | 発行者名(未設定時は「未設定」と表示) |
| `BUSINESS_ADDRESS` | 請求書時 | 発行者住所 |
| `BUSINESS_PHONE` | 任意 | 発行者電話番号 |
| `BUSINESS_BANK_ACCOUNT` | 請求書時 | 振込先口座 |
| `INVOICE_REGISTRATION_NUMBER` | 任意 | インボイス登録番号 |
| `TAX_STATUS` | 任意 | `tax_exempt` で消費税非表示(デフォルト課税) |
| `TAX_METHOD` | 任意 | `general`(本則) / `simple`(簡易、デフォルト) |
| `TAX_BUSINESS_CATEGORY` | 任意 | 簡易課税事業区分 1〜6 (デフォルト `5`=サービス業) |
| `GMAIL_CLIENT_ID` | メール送信時 | Gmail API OAuth2 クライアント ID |
| `GMAIL_CLIENT_SECRET` | メール送信時 | Gmail API OAuth2 クライアントシークレット |
| `GMAIL_REFRESH_TOKEN` | メール送信時 | Gmail API リフレッシュトークン |
| `GMAIL_USER` | メール送信時 | 送信元 Gmail アドレス |
| `BUSINESS_NOTIFY_EMAIL` | メール送信時 | 支払リマインダー送信先メールアドレス |
| `TAX_ACCOUNTANT_EMAIL` | 任意 | 税理士宛メール下書きの宛先プレースホルダ |
| `NOTION_TOKEN` | Notion 連携時 | Notion Integration Secret |
| `NOTION_DB_MONTHLY_REPORT_ID` | Notion 連携時 | 月次レポート DB の ID |

---

## クイックスタート (月次サイクル)

```bash
# 依存インストール(リポジトリ直下で 1 回だけ)
npm install

# ── 月中 ──────────────────────────────────────────────────
# 1. 請求書発行
cp accounting/templates/invoice.example.md \
   accounting/inputs/invoices/2026-05-クライアント名.md
# (frontmatter を編集してから)
npm run invoice -- accounting/inputs/invoices/2026-05-クライアント名.md

# 2. 銀行・カード明細 CSV を配置
cp ~/Downloads/明細.csv accounting/inputs/bank-csv/2026-05-card.csv

# 3. 経費仕訳 (AI が勘定科目を推定)
npm run categorize -- accounting/inputs/bank-csv/2026-05-card.csv

# 4. 入金消込 (提案 → 確認 → 確定)
npm run reconcile -- accounting/inputs/bank-csv/2026-05-bank.csv
npm run reconcile -- accounting/inputs/bank-csv/2026-05-bank.csv --confirm

# 5. 支払予定リマインダー (毎朝または手動)
npm run payments

# ── 月末 ──────────────────────────────────────────────────
# 6. 月次レポート生成
npm run monthly-report -- 2026-05

# 7. 税理士向けパッケージ生成 → checklist.md を確認して送付
cp ~/receipts/*.pdf accounting/inputs/receipts/2026-05/
npm run tax-package -- 2026-05 --zip
```

---

## 各機能の概要

| npm script | STEP | 概要 | 主要入力 | 主要出力 |
|---|---|---|---|---|
| `invoice` | 2 | 請求書 PDF の自動生成 | `inputs/invoices/*.md` | `outputs/invoices/*.pdf` |
| `categorize` | 3 | 銀行 CSV の AI 仕訳 | `inputs/bank-csv/*.csv` | `outputs/categorize/*.csv` |
| `reconcile` | 4 | 入金消込の補助 | 請求書台帳 + 銀行 CSV | `outputs/reconcile/*.md` |
| `payments` | 5 | 支払予定リマインダー | `inputs/payables/*.md` | `outputs/payments/*.md` |
| `monthly-report` | 6 | 月次レポートの自動生成 | 請求書台帳 + 仕訳 CSV | `outputs/monthly-reports/*.md` |
| `tax-package` | 7 | 税理士向け月次パッケージ | 全 STEP の出力 + 領収書 | `outputs/tax-packages/<yyyymm>/` |

---

## 請求書の自動生成 (`npm run invoice`)

### 使い方

```bash
npm run invoice -- accounting/inputs/invoices/2026-05-クライアント名.md --dry-run
npm run invoice -- accounting/inputs/invoices/2026-05-クライアント名.md
npm run invoice -- accounting/inputs/invoices/2026-05-クライアント名.md --withholding
```

| フラグ | 説明 |
|---|---|
| `--withholding` | 源泉徴収明細を追加 |
| `--dry-run` | 計算結果と Markdown プレビュー(先頭 500 文字)のみ表示 |

### 請求書番号と欠番

- 採番形式: `INV-YYYY-NNNN`(4 桁ゼロパディング)
- `state/invoice-counter.json` で管理。年をまたぐと 1 にリセット
- 採番後の処理失敗 → 欠番は許容設計。meta.json が存在しない番号として確認できる

### 出力

- `outputs/invoices/INV-YYYY-NNNN.pdf` — A4 縦 PDF
- `outputs/invoices/INV-YYYY-NNNN.meta.json` — 入金消込(STEP 4)で参照。**削除しないこと**

---

## 経費の自動仕訳 (`npm run categorize`)

> ⚠️ **AI 仕訳は補助。最終確認は税理士へ。**

### 使い方

```bash
npm run categorize -- accounting/inputs/bank-csv/2026-05-card.csv
npm run categorize -- accounting/inputs/bank-csv/2026-05-card.csv --check-invoice-number
npm run categorize -- accounting/inputs/bank-csv/2026-05-mufg.csv --encoding sjis
npm run categorize -- accounting/inputs/bank-csv/custom.csv --format manual \
  --manual-mapping accounting/inputs/bank-csv/my-mapping.json
```

### サポート形式

| 形式キー | 銀行 / サービス |
|---|---|
| `moneyforward` | マネーフォワード ME |
| `freee` | freee 会計 |
| `mufg` | 三菱 UFJ 銀行 |
| `manual` | 不明形式(手動マッピング) |

### 重複検出

`date|description|amount` の SHA-256(先頭 16 文字)で重複を検出。
再分類したい場合は `state/categorized.json` の該当ハッシュを削除して再実行。

### 出力

- `outputs/categorize/<base>.entries.csv` — 全エントリ仕訳 CSV
- `outputs/categorize/<base>.by-account.csv` — 勘定科目別集計
- `outputs/categorize/<base>.summary.md` — 要確認・インボイス注意事項

---

## 入金消込の補助 (`npm run reconcile`)

> ⚠️ **自動確定は補助手段。最終判断は人が行ってください。**

### 使い方

```bash
npm run reconcile -- accounting/inputs/bank-csv/2026-05-bank.csv
npm run reconcile -- accounting/inputs/bank-csv/2026-05-bank.csv --confirm
```

### スコア計算式

```
amount_score = 完全一致 1.0 / 手数料控除後一致 0.85
name_score   = Jaro-Winkler(正規化した振込人名, 正規化した顧客名)
date_score   = 1 - 経過日数 / days-window

total_score  = 0.5 × amount_score + 0.35 × name_score + 0.15 × date_score
```

### 自動確定の 3 条件(すべて満たす場合のみ `--confirm` で記録)

1. `total_score >= 0.95`
2. `amount_score == 1.0`(金額完全一致)
3. `name_score >= 0.85`(Jaro-Winkler)

### 手動確定

`state/reconciled.json` に直接追記。`"method": "manual"` を使用。

---

## 支払予定の管理 (`npm run payments`)

> ⚠️ **メール通知は補助。最終的な支払操作は人が銀行アプリ等で実施してください。**

### 使い方

```bash
cp accounting/templates/payable.example.md \
   accounting/inputs/payables/sample-vendor-INV001.md
npm run payments -- --dry-run
npm run payments
npm run payments -- --no-mail
```

### オプション

| オプション | デフォルト | 説明 |
|---|---|---|
| `--ahead-days <N,M>` | `3,7` | N 日前・M 日前リマインダー(カンマ区切り) |
| `--no-overdue` | (なし) | 期日超過分を除外 |
| `--to <email>` | `BUSINESS_NOTIFY_EMAIL` | 送信先を上書き |
| `--no-mail` | (なし) | メール送信せずファイル出力のみ(state は更新しない) |
| `--dry-run` | (なし) | 何も書き込まずプレビューのみ |

### 送信済み重複防止

`state/payments-sent.json` で `(vendor, invoice, reminder_type, 実行日)` を管理。
日付が変わると同じリマインダーを再送できる(打ち損なった場合の救済)。

### 支払完了の運用

`inputs/payables/*.md` の `paid: true` + `paid_at: YYYY-MM-DD` に変更 → 次回実行からスキップ。

---

## 月次レポートの自動生成 (`npm run monthly-report`)

> ⚠️ **AI 補助による出力。最終確認は人 / 税理士が行うこと。推定納税額は粗い概算です。**

### 使い方

```bash
npm run monthly-report -- 2026-05
npm run monthly-report -- 2026-05 --compare-prev-month
npm run monthly-report -- 2026-05 --compare-prev-year
npm run monthly-report -- 2026-05 --notion
npm run monthly-report -- 2026-05 --dry-run
```

### 税種別オプション

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `TAX_STATUS` | `taxable` | `tax_exempt` で消費税を 0 として計算 |
| `TAX_METHOD` | `simple` | `general`(本則) / `simple`(簡易課税) |
| `TAX_BUSINESS_CATEGORY` | `5` | 簡易課税の事業区分 1〜6 |

### 推定納税額の限界

以下の控除・調整は**一切考慮していません**:
- 基礎控除・青色申告特別控除・社会保険料控除・配偶者控除・扶養控除
- 住民税の均等割(年 5,000 円程度)
- 損益通算・繰越欠損金・税額控除

**実際の納税額確定は必ず税理士に依頼してください。**

### 消費税逆算の誤差

経費 CSV は税込金額のみを保持。内税前提(10%)で逆算するため、
軽減税率(8%)対象経費が混在する場合は誤差が発生する。

---

## 税理士向け月次パッケージ (`npm run tax-package`)

> ⚠️ **税理士提出前に必ず `checklist.md` を確認してください。**

### 使い方

```bash
cp ~/receipts/*.pdf accounting/inputs/receipts/2026-05/
npm run tax-package -- 2026-05
npm run tax-package -- 2026-05 --zip
npm run tax-package -- 2026-05 --dry-run
```

### 出力構造

```
outputs/tax-packages/2026-05/
├── checklist.md          ← 提出前チェックリスト (✅/⚠️)
├── accountant-email.md   ← 税理士宛メール下書き
├── 00-monthly-report.md
├── 01-invoices/          ← PDF + meta.json + 集約 CSV
├── 02-expenses/          ← 仕訳集約 CSV + 元ソース
├── 03-bank-statements/   ← 銀行明細 CSV
├── 04-reconcile/         ← 消込確定一覧 + 提案 CSV
├── 05-payments/          ← 支払実績 CSV
└── 06-receipts/          ← 領収書 (inputs/receipts/YYYY-MM/ からコピー)
```

---

## 機微情報の取り扱い

### gitignore 対象

| パス | 理由 |
|---|---|
| `accounting/inputs/invoices/*.md` | 顧客名・金額・案件名 |
| `accounting/inputs/payables/*.md` | 取引先名・支払金額 |
| `accounting/inputs/bank-csv/*.csv` | 口座番号・取引明細 |
| `accounting/inputs/receipts/*/` | 領収書(個人情報含む) |
| `accounting/outputs/**` | 上記のすべての生成物 |
| `accounting/state/**` | 消込履歴・採番状態 |

- **誤コミット防止**: `git add -A` や `git add .` は使わず、ファイルを個別に指定する
- **バックアップ**: `outputs/` と `state/` は git 管理外なので、外部ストレージへの定期バックアップを推奨
- **Notion push**: Integration の権限スコープに注意。DB 単位での接続を推奨

### state/ の役割

| ファイル | 内容 |
|---|---|
| `state/invoice-counter.json` | 請求書採番カウンタ |
| `state/categorized.json` | AI 仕訳済みハッシュ(重複スキップ用) |
| `state/reconciled.json` | 消込確定記録 |
| `state/payments-sent.json` | 送信済みリマインダー記録 |
| `state/vendor-registry.json` | 取引先インボイス番号レジストリ |

---

## Notion 連携セットアップ

### 1. Notion Integration を作成

1. https://www.notion.so/my-integrations にアクセス
2. 「新しいインテグレーション」を作成、スコープ: `Insert content` / `Read content`
3. 「インテグレーションシークレット」をコピー → `.env` の `NOTION_TOKEN` に設定

### 2. 月次レポート DB を作成してプロパティを追加

| プロパティ名 | 種類 | 説明 |
|---|---|---|
| `Month` | タイトル | "2026-05" 形式 |
| `Revenue` | 数値 | 売上(税抜) |
| `Expenses` | 数値 | 経費合計 |
| `Gross Profit` | 数値 | 粗利 |
| `Estimated Tax` | 数値 | 推定納税額(月割) |
| `Generated At` | 日付 | 生成日 |

### 3. DB を Integration と共有

DB ページ右上「...」→「接続先を追加」→ 作成した Integration を選択

### 4. `.env` に追記

```
NOTION_TOKEN=secret_xxxx
NOTION_DB_MONTHLY_REPORT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

(DB ID は Notion ページ URL の 32 桁英数字部分)

### 5. 実行

```bash
npm run monthly-report -- 2026-05 --notion
```

---

## GitHub Actions

### accounting-payments.yml (毎朝 09:00 JST)

`.github/workflows/accounting-payments.yml` で稼働中。

**動作**: `npm run payments` を実行し、支払期日が近い payable をメールで通知。

**重要な制約**: `accounting/inputs/payables/` は gitignore のため
Actions 環境にファイルが存在しない。**対象 0 件でのスキップが正常動作**。
実運用では人がローカルで実行してください。

### accounting-monthly-report.yml (毎月 5 日 09:00 JST)

`.github/workflows/accounting-monthly-report.yml` で稼働中。

**動作**: 前月分の月次レポートを生成し、Notion に投稿(--notion)。
`workflow_dispatch` で手動実行時に対象月を指定可能。

**重要な制約**: `inputs/` および `outputs/` が gitignore のため、
Actions 環境に入力データが存在しない。意味のあるレポートは
人がローカルで実行してください。

### secrets 登録手順

GitHub リポジトリ → Settings → Secrets and variables → Actions → 「New repository secret」

| Secret 名 | 説明 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API キー |
| `GMAIL_CLIENT_ID` | Gmail API クライアント ID |
| `GMAIL_CLIENT_SECRET` | Gmail API クライアントシークレット |
| `GMAIL_REFRESH_TOKEN` | Gmail API リフレッシュトークン |
| `GMAIL_USER` | 送信元 Gmail アドレス |
| `BUSINESS_NOTIFY_EMAIL` | 通知先メールアドレス |
| `NOTION_TOKEN` | Notion Integration Secret |
| `NOTION_DB_MONTHLY_REPORT_ID` | 月次レポート DB の ID |
| `TAX_STATUS` | `taxable` または `tax_exempt` |
| `TAX_METHOD` | `simple` または `general` |
| `TAX_BUSINESS_CATEGORY` | 簡易課税事業区分(1〜6) |

### 将来課題: inputs/ を Actions で取得する方法

payables や bank-csv を Actions に渡す場合、以下のいずれかを検討:
- プライベートリポジトリに inputs/ を別管理 → Actions でクローン
- GitHub Encrypted Secrets に Base64 エンコードして保存
- AWS S3 / Google Drive 等の外部ストレージから fetch

---

## トラブルシュート

### メール送信失敗 (Gmail 認証情報未設定)

```
[error] メール送信失敗: Gmail 認証情報が未設定です。
```

→ `.env` に `GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN` を設定、
または `--no-mail` / `--dry-run` で実行。認証エラーでもファイル出力は継続する。

### CSV 形式が自動判定できない

```
[warn] 不明形式のため manual フォールバック
```

→ `--format manual --manual-mapping <json>` を指定。
`accounting/templates/manual-mapping.example.json` をコピーして編集。

### Notion 連携が動かない

- `NOTION_TOKEN` が正しく設定されているか確認
- Notion DB のページで「接続先を追加」→ Integration を共有しているか確認
- `NOTION_DB_MONTHLY_REPORT_ID` が DB ページ URL の 32 桁 ID か確認
- DB のプロパティ名が README の表と一致しているか確認

### 請求書番号の欠番

採番後に PDF 生成が失敗すると欠番が生じる。欠番は許容設計。
`state/invoice-counter.json` を直接編集してカウンタを巻き戻すことも可能
(ただし過去の meta.json の番号と衝突しないよう注意)。

### 経費の AI 仕訳が誤分類

1. `state/categorized.json` から該当ハッシュを削除
2. `npm run categorize -- <csv>` を再実行
3. 再分類結果を確認してから税理士に渡す

---

## 税制改正対応

### 年次チェックの仕組み

毎年 4 月 1 日 09:00 JST に GitHub Actions が自動で Issue を起票します。

```
.github/workflows/tax-rates-annual-check.yml
→ npm run tax-rates-check で Markdown チェックリストを生成
→ GitHub Issue として起票 (ラベル: tax-rates, annual-review, accounting)
```

### 手動チェック

```bash
# Markdown チェックリスト (人が確認しやすい形式)
npm run tax-rates-check

# JSON (他スクリプトから参照する場合)
npm run tax-rates-check -- --format json
```

### 改正発覚時の更新手順

1. `accounting/lib/tax-rates.js` の定数を更新
2. `accounting/lib/tax-estimate.js` の累進テーブル `INCOME_TAX_BRACKETS` を更新
3. `accounting/lib/tax-rates.js` の `LAST_UPDATED` を更新 (例: `'2027-04'`)
4. `accounting/README.md` の「法令時点」セクションを更新
5. `npm run tax-rates-check` で変更内容を確認
6. `npm run monthly-report -- <yyyymm> --dry-run` で月次レポートへの影響を確認

### LAST_UPDATED の意味

`accounting/lib/tax-rates.js` の `LAST_UPDATED` は「このコードに組み込まれた税率の基準時点」を表します。
税制改正で値を更新した場合は必ず一緒に更新してください。

### 改正のタイミング

- **通常**: 4 月 1 日施行
- **国会通過**: 前年 12 月〜翌年 3 月頃
- **確認推奨時期**: 毎年 3 月末〜4 月初旬 (国税庁・財務省の発表に注意)

---

## 法令時点

- 税率は **2026 年 5 月時点**
- 消費税: 標準税率 10%、軽減税率 8%
- 源泉徴収: 100 万円以下 10.21%、超過分 20.42%
- 所得税: 超過累進(5%〜45%)+ 復興特別所得税 2.1%
- 住民税: 一律 10%(均等割除く)
- 簡易課税みなし仕入率: 事業区分 5(サービス業)= 50%

**法令改正時の更新箇所**:
- `accounting/lib/tax-rates.js` — 消費税・源泉徴収税率
- `accounting/lib/tax-estimate.js` — 所得税累進テーブル・みなし仕入率

---

## 他部門との連携

- **営業部門(`sales/`)**: 見積書・提案書のフォーマットと請求書を統一することで
  顧客ごとの売上管理が容易になる。将来的に `sales` の案件情報から
  請求書を自動生成する連携を検討
- **開発企画部門(`planning/`)**: 案件マスタ(`planning/inputs/projects.md`)の
  `project_code` を請求書の案件コードと紐付けることで、月次レポートに
  案件別売上を含められる

---

## 営業 → 経理 受注連携 (`npm run sync-from-sales`)

> ⚠️ **下書き生成は自動。請求書 PDF の最終発行は人の確認後に手動実行してください。**

### 使い方

```bash
# 自動ソース判定 (Sheets または local フォールバック)
npm run sync-from-sales

# ローカルファイルで確認のみ
npm run sync-from-sales -- --source local --dry-run

# AI 補完なし (frontmatter の情報だけで生成)
npm run sync-from-sales -- --source local --no-ai

# 特定日以降の受注のみ
npm run sync-from-sales -- --since 2026-05-01
```

### 生成される下書きの構造

- パス: `accounting/inputs/invoices/draft-<YYYYMMDD>-<案件名>.md`
- `needs_review: true` の場合は `unit_price: null` が含まれる
- `billing_source: frontmatter` → 営業データから完全生成
- `billing_source: ai-completed` → AI が品目名・支払条件を補完（金額は null）
- `billing_source: needs-review` → 手動入力必須

### 下書き確認後の請求書発行

```bash
# 1. 下書きを開いて確認・編集 (特に unit_price が null の場合)
# 2. 問題なければ
npm run invoice -- accounting/inputs/invoices/draft-20260516-案件名.md
```
発行成功後、`state/sales-to-accounting.json` に `issued_invoice_number` が自動記録されます。

### state/sales-to-accounting.json の役割

- 受注案件ごとの下書き生成履歴・発行済み請求書番号を管理
- 重複生成を防止（同一案件の下書きを二重生成しない）
- `issued_invoice_number` と `reviewed_at` は請求書発行後に自動更新

### GitHub Actions 連携

`.github/workflows/sync-from-sales.yml` が毎朝 09:30 JST (sales:reminder の 30 分後) に実行。
Sheets ソース利用時: `SALES_SHEET_ID` Secret を設定してください。
生成された下書きは gitignore のため Actions ではコミットされません。**本格運用はローカル実行を推奨。**

---

## Gmail からの領収書自動取り込み (`npm run fetch-receipts`)

> ⚠️ **OCR は AI 補助による出力。最終確認は人が行うこと。**

### 使い方

```bash
# ローカルフォルダをスキャン
npm run fetch-receipts -- --mode local --local-dir ~/Downloads

# Gmail から取得 (過去 7 日分)
npm run fetch-receipts -- --mode gmail --days 7

# 内容確認のみ
npm run fetch-receipts -- --mode local --local-dir ~/Downloads --dry-run

# OCR なしで配置のみ
npm run fetch-receipts -- --mode local --local-dir ~/Downloads --no-ocr
```

### Gmail 検索クエリ

既定クエリ: `has:attachment (filename:pdf OR ...) (領収書 OR receipt OR ...)`

`--query` オプションで上書き可能:
```bash
npm run fetch-receipts -- --mode gmail --query 'from:amazon subject:領収書'
```

### OAuth スコープ注意

Gmail 受信機能には `https://www.googleapis.com/auth/gmail.readonly` スコープが必要です。
タスク 1 で設定した Gmail OAuth クライアントに未付与の場合は追加してリフレッシュトークンを再発行してください。

### OCR 結果の限界

- ダミー/空白ファイルや低解像度画像は `confidence=0, needs_review=true` になります
- `vendor/amount` が null の場合も `needs_review=true` です
- 税務証憑としての最終確認は人が行ってください

### 出力ファイル

| ファイル | 内容 |
|---|---|
| `outputs/fetch-receipts/<YYYY-MM-DD>.md` | 取り込みサマリ (要確認一覧付き) |
| `outputs/fetch-receipts/<YYYY-MM-DD>.csv` | メタ情報 CSV (税理士確認用) |
| `state/receipts-index.json` | 全領収書インデックス (将来 categorize と突合予定) |
| `state/receipt-fetch.json` | Gmail 処理済みメッセージ ID (重複防止) |

---

## Gmail 実装について

Gmail 送信ロジックは `lib/mailer.js` (リポジトリ直下) に移管しました。
`accounting/lib/mailer.js` はその薄いラッパーとして残しています。
`accounting/scripts/payments.js` の require パスは変更不要です。

---

## AI 補助の限界

- 勘定科目の割り当ては Claude の推定。**最終確認は人が行う**こと
- 消費税区分(課税・非課税・不課税・免税)の判断は Claude では保証できない
- インボイス制度への対応(登録番号確認等)は人が確認すること
- 月次レポートの推定納税額は概算。各種控除は未考慮
- **税務申告には税理士への確認を必ず行うこと**
