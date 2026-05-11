# ICHI 技術部門 自動化モジュール

Claude API を活用した技術部門向け自動化スクリプト群。

## 目的

| 機能 | 説明 |
|------|------|
| 案件リポジトリ自動セットアップ | 新規プロジェクト開始時に標準ディレクトリ構成・設定ファイル・CI テンプレートを自動生成 |
| PR 自動レビュー | pull request の diff を解析し、バグ・セキュリティリスク・コーディング規約の問題を指摘 |
| テスト自動生成 | 既存コードから単体テスト・統合テストのひな形を自動生成 |
| ドキュメント自動生成 | コード・API 仕様・アーキテクチャ図のドキュメントを自動生成 |
| 障害トリアージ | エラーログ・スタックトレースを解析し、根本原因と対処方針を提示 |

## ディレクトリ構成

```
engineering/
├── lib/
│   └── claude.js        # Anthropic クライアント・共通ヘルパー
├── scripts/             # 実行スクリプト本体
├── templates/           # プロンプトテンプレート・出力テンプレート
├── inputs/              # スクリプトへの入力ファイル置き場
├── outputs/             # 生成物の出力先
└── README.md
```

## セットアップ

リポジトリ直下の `.env` に API キーを設定済みであれば追加作業は不要です。

```
ANTHROPIC_API_KEY=sk-ant-...
```

## npm run コマンド

> 以下は root の `package.json` から実行します。

| コマンド | 説明 | 状態 |
|----------|------|------|
| `npm run new-project` | 案件リポジトリの標準構成を自動セットアップ | 実装済 |
| `npm run gen:test` | 指定ファイルのテストコードを自動生成 | 実装済 |
| `npm run gen:docs` | コード・API のドキュメントを自動生成 | 実装済 |
| `npm run triage` | エラーログを解析して障害をトリアージ | 実装済 |
| `npm run smoke:eng` | API 疎通確認用スモークテスト | 実装済 |

### triage の使い方

> **セキュリティ注意**
> 入力エラーログは Anthropic の Claude API に送信されます。
> シークレット・個人情報・本番接続情報が含まれていないか目視確認してから実行してください。
> 実ログは `engineering/inputs/*.md` として保存すれば `inputs/.gitignore` により誤コミットを防げます
> (`*.example.md` パターンのファイルのみ追跡対象に残します)。

```bash
# Issue 草案を生成して outputs/triage/YYYYMMDD-HHmmss.md に保存
npm run triage -- --input engineering/inputs/error-log.example.md

# GitHub Issue として起票 (repo を明示)
npm run triage -- --input my-incident.md --create-issue --repo owner/repo

# git リモートから owner/repo を自動推測して起票
npm run triage -- --input my-incident.md --create-issue
```

入力ファイルのフォーマット (`engineering/inputs/error-log.example.md` を参照):

```markdown
# 障害発生報告

## 発生日時
YYYY-MM-DD HH:MM (JST)

## 影響範囲(分かっている範囲)
- <例: 本番 API の /users エンドポイントが 500 を返す>

## エラーログ
    <スタックトレースや JSON ログを 4 スペースインデントで貼る>

## 関連情報
- <デプロイ直後 / 特定ユーザのみ など>
```

### gen:test の使い方

```bash
# デフォルト出力先 (JS: 同階層の <basename>.test.js / Py: tests/test_<basename>.py)
npm run gen:test -- --src engineering/inputs/sample-source.js

# 出力先を明示
npm run gen:test -- --src src/utils.js --out tests/utils.test.js
```

既存ファイルがある場合は上書きせず `<出力パス>.new` として保存し警告を表示します。

### gen:docs の使い方

```bash
# デフォルト出力先: engineering/outputs/docs/<basename>.md
npm run gen:docs -- --src engineering/inputs/sample-source.js

# 出力先を明示
npm run gen:docs -- --src src/api.js --out docs/api.md
```

### new-project の使い方

```bash
# 基本 (スタックを入力ファイルから読む)
npm run new-project -- --input engineering/inputs/project-spec.example.md --out /path/to/new-repo

# スタックを明示指定
npm run new-project -- --input engineering/inputs/project-spec.example.md --out /path/to/new-repo --stack node

# 出力先が既存でも上書き
npm run new-project -- --input engineering/inputs/my-spec.md --out /path/to/new-repo --stack python --force
```

入力ファイルのフォーマット (`engineering/inputs/project-spec.example.md` を参照):

```markdown
# 案件: <案件名>
- 顧客名: <顧客名>
- 技術スタック: node | python | static
- 概要: <プロジェクト概要>
- 主要機能:
  - <機能 1>
  - <機能 2>
```

生成されるファイル構成 (node の例):

```
<out>/
├── .github/workflows/ci.yml
├── src/index.js
├── tests/index.test.js
├── .gitignore
├── LICENSE
├── package.json
└── README.md          ← Claude API で概要・機能を自然な日本語に整形
```

## PR 自動レビュー

### 動作

`main` ブランチへの Pull Request が opened / synchronize / reopened されると、
`.github/workflows/pr-review.yml` が起動し `engineering/scripts/pr-review.js` が実行されます。
スクリプトは PR の diff と本文を Claude API に送り、生成されたレビューを PR コメントとして自動投稿します。

レビューの観点: 設計・アーキテクチャ / 命名・可読性 / エラーハンドリング / セキュリティ / テストの不足 / 行レベルの改善提案

スキップ条件:
- PR タイトルまたは本文に `[skip-review]` を含める
- dependabot 等の Bot ユーザーからの PR

### 他リポジトリへの転用

以下の 2 ファイルをコピーするだけで別リポジトリでも動作します:

```
.github/workflows/pr-review.yml
engineering/scripts/pr-review.js   ← lib/claude.js ごとコピー推奨
```

転用先リポジトリで `ANTHROPIC_API_KEY` を GitHub Secrets に登録してください。

### ローカル dry-run

```bash
# 任意の diff ファイルを用意
git diff HEAD~1 > /tmp/my.diff

# dry-run (GitHub API は呼ばず stdout にレビューを出力)
node engineering/scripts/pr-review.js --dry-run --diff-file /tmp/my.diff
```

### セキュリティ注意

> **diff は Anthropic の Claude API に送信されます。**
> 機微情報を含むリポジトリ・社外秘の案件リポジトリでは、
> GitHub Secrets に `ANTHROPIC_API_KEY` を**設定しない**ことでワークフローを実質無効化できます
> (`ANTHROPIC_API_KEY` が未設定だと `pr-review.js` が起動直後にエラーで終了します)。
> diff に含まれうるシークレット・個人情報・本番接続情報には十分注意してください。

## セキュリティ注意喚起

**PR レビュー機能 (`gen:review`) は pull request の diff を Anthropic の Claude API に送信します。**

以下に該当するリポジトリでの利用は、情報漏洩リスクを十分に検討した上で実施してください。

- 未公開の独自アルゴリズム・ビジネスロジックを含むコード
- 個人情報・顧客情報を含むコード・設定ファイル
- API キー・パスワード・証明書などの認証情報
- 社外秘扱いの情報全般

送信前に diff を目視確認し、機微情報が含まれる場合は該当箇所を除外するかレビューをスキップしてください。

<!-- smoke test -->
