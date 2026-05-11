# ICHI 営業部門 自動化

## 概要

- 提案書・見積書・フォローアップメールを Claude API で自動生成
- パイプライン管理は Google Sheets + Apps Script

## ディレクトリ構成

- proposals/ : 提案書生成スクリプト
- quotes/    : 見積書生成スクリプト
- followups/ : フォローメール生成スクリプト
- pipeline/  : Apps Script のソース管理
- inputs/    : 入力ファイル（顧客情報・議事録）
- outputs/   : 生成物（PDF / Markdown）
- lib/       : 共通モジュール（Claude API 呼び出し）

## 使い方

```bash
npm run proposal
npm run quote
npm run followup
```

## 環境変数

- リポジトリ直下の .env から ANTHROPIC_API_KEY を読み込む
