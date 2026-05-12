# ICHI 開発企画部門 自動化

開発企画部門の業務(要件定義・工数見積もり・競合リサーチ・ロードマップ管理・案件進捗集約・週次振り返り)を **Claude API + GitHub + Google Sheets** で自動化するスクリプト群。

> ⚠️ 全スクリプトの出力は AI 補助による生成物です。最終判断は必ず人が行ってください。

---

## クイックスタート

```bash
# 1. 依存インストール(リポジトリ直下で実行)
npm install

# 2. 入力ファイルを準備(各機能の example をコピー)
cp planning/inputs/roadmap.example.md planning/inputs/roadmap.md
cp planning/inputs/projects.example.md planning/inputs/projects.md
cp planning/inputs/requirements/SAMPLE-001.project.example.md \
   planning/inputs/requirements/SAMPLE-001.project.md
cp planning/inputs/requirements/SAMPLE-001.hearing.example.md \
   planning/inputs/requirements/SAMPLE-001.hearing.md

# 3. 実行例(外部依存なしで動作確認)
npm run gen:requirements -- --project SAMPLE-001
npm run estimate -- --requirements planning/outputs/requirements/SAMPLE-001.md
npm run roadmap
npm run dashboard -- --skip-sheets --skip-github
npm run weekly-report -- --skip-github
```

---

## 機能一覧

| npm script | 概要 | 主要入力 | 主要出力 | Notion | 外部 API |
|---|---|---|---|---|---|
| `gen:requirements` | 要件定義書の自動生成 | 案件情報 + ヒアリングメモ | `outputs/requirements/` | ✓ | Claude |
| `estimate` | 工数見積もりの補助 | 要件定義書 or 機能リスト | `outputs/estimates/` | — | Claude |
| `research` | 競合・市場リサーチ | リサーチテーマ Markdown | `outputs/research/` | ✓ | Claude + **Web 検索(課金)** |
| `roadmap` | ロードマップ遅延リスク評価 | `inputs/roadmap.md` | `outputs/roadmap/` | ✓ | Claude |
| `dashboard` | 案件進捗ダッシュボード | 案件マスタ + ロードマップ | `outputs/dashboard/` | ✓ | Claude + Sheets + GitHub |
| `weekly-report` | 週次レポート | 案件マスタ + ロードマップ | `outputs/weekly/` | ✓ | Claude + GitHub |

---

## セットアップ

### Node.js バージョン

Node.js 18 以上が必要です(`package.json` の `engines.node: ">=18.0.0"`)。

### 依存インストール

```bash
npm install
```

### 環境変数(`.env`)

リポジトリ直下の `.env` ファイルに設定します。`.env.example` をテンプレートとして利用できます。

| 変数名 | 必須 | 用途 |
|---|---|---|
| `ANTHROPIC_API_KEY` | **必須** | Claude API(技術・営業部門と共通) |
| `GITHUB_TOKEN` | GitHub 連携時 | Personal Access Token (`read:repo` 権限)。技術部門の PR レビューと共通。 |
| `PIPELINE_SHEET_ID` | Sheets 連携時 | Google Sheets スプレッドシート ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Sheets 連携時 | サービスアカウント JSON の内容(文字列) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Sheets 連携時 | サービスアカウント JSON のファイルパス(上記の代替) |
| `NOTION_TOKEN` | Notion 連携時 | Notion Integration Secret |
| `NOTION_DB_REQUIREMENTS_ID` | Notion 連携時 | 要件定義 DB の ID |
| `NOTION_DB_ROADMAP_ID` | Notion 連携時 | ロードマップ DB の ID |
| `NOTION_DB_RESEARCH_ID` | Notion 連携時 | リサーチ DB の ID |
| `NOTION_DB_PROJECTS_ID` | Notion 連携時 | 案件管理 DB の ID |
| `NOTION_DB_WEEKLY_ID` | Notion 連携時 | 週次レポート DB の ID |

営業 Sheets 連携の詳細な認証設定は、`sales/README.md` を参照してください。

---

## 各機能の詳細

### `gen:requirements` — 要件定義書の自動生成

案件情報(frontmatter 付き Markdown)と顧客ヒアリングメモを入力として、Claude が要件定義書 Markdown を生成します。出力の機能要件セクション(`### F-XXX:` 形式)は `estimate` でそのまま入力として使えます。

**入力ファイル** (`planning/inputs/requirements/`):

- `<案件コード>.project.md` — 案件概要 + YAML frontmatter(client / project / project_code / start_date / deadline / budget_range)
- `<案件コード>.hearing.md` — ヒアリングメモ(自由書式)

**CLI オプション**:

```bash
npm run gen:requirements -- \
  --project <案件コード>          # 必須
  [--input-dir <dir>]            # デフォルト: planning/inputs/requirements
  [--example]                    # .example.md にフォールバック
  [--force]                      # 既存出力を上書き
  [--notion]                     # Notion DB に push
```

**出力**: `planning/outputs/requirements/<案件コード>.md`

---

### `estimate` — 工数見積もりの補助

> ⚠️ AI 生成の見積もりは初期推定です。前提条件・チームスキル・既存資産により大きく変動します。**最終調整は必ず人が行ってください。**

機能リスト(または `gen:requirements` の出力)を入力として、T-shirt サイジング(S/M/L/XL)と人日見積もり(楽観/最頻/悲観)を生成します。

**CLI オプション**:

```bash
npm run estimate -- \
  ( --requirements <path> | --features <path> )  # どちらか必須
  [--out <path>]
  [--project-context <text>]     # チーム規模・技術スタック等の補足
```

**出力**: `planning/outputs/estimates/<入力ファイル名>.estimate.md`

---

### `research` — 競合・市場リサーチの自動化

> ⚠️ **Web 検索ツール(`web_search_20250305`)は Anthropic API の課金対象機能です。**
> 料金: **$10 / 1,000 searches** + 通常トークン料金。
> 大量実行前に [Anthropic Console](https://console.anthropic.com) で利用状況を確認してください。

**入力ファイル** (`planning/inputs/research/`):

```yaml
---
title: リサーチタイトル
target_market: 対象市場
max_competitors: 8
max_searches: 5
---

# リサーチ目的
...
# 重点的に知りたいこと
...
# 除外したい領域
...
```

**CLI オプション**:

```bash
npm run research -- \
  --input <path>                 # 必須
  [--max-uses <n>]               # Web 検索上限(デフォルト: 5)
  [--out <path>]
  [--notion]
```

**出力**: `planning/outputs/research/<入力ファイル名>.md`

---

### `roadmap` — ロードマップ遅延リスク評価

**マスタ** `planning/inputs/roadmap.md` を人が手で編集します。スクリプトはマスタを書き換えません。

**マスタ形式**:

```markdown
### M-001: マイルストーン名

- id: M-001
- name: マイルストーン名
- deadline: 2026-09-30
- status: 未着手 | 進行中 | 完了 | 遅延
- related_projects: SAMPLE-001
- progress_note: 進捗状況を自由記述
- blockers: ブロッカー or「なし」
```

**CLI オプション**:

```bash
npm run roadmap -- \
  [--input planning/inputs/roadmap.md]   # デフォルト値
  [--out <path>]
  [--notion]
```

**出力**: `planning/outputs/roadmap/<YYYYMMDD>.md`(同日 2 回目以降は連番)

---

### `dashboard` — 案件進捗ダッシュボード

> ⚠️ 出力は顧客名・案件機微情報を含みます。`planning/outputs/` は gitignore 済みですが、Notion push 時の共有範囲に注意してください。

**案件マスタ** `planning/inputs/projects.md` を人が手で編集します。

**マスタ形式**:

```markdown
### SAMPLE-001: 在庫管理システム刷新

- project_code: SAMPLE-001
- project_name: 在庫管理システム刷新
- client: 株式会社テクノ精工
- repos: owner/repo1, owner/repo2        # owner/repo 形式、カンマ区切り
- sheets_id: 在庫管理システム刷新         # 営業 Sheets「案件名」列でマッチ
- roadmap_ids: M-001, M-003
- requirements_path: planning/outputs/requirements/SAMPLE-001.md
- status: 提案中 | 進行中 | 保守 | 完了 | 休止
```

**CLI オプション**:

```bash
npm run dashboard -- \
  [--projects planning/inputs/projects.md]
  [--roadmap planning/inputs/roadmap.md]
  [--out <path>]
  [--skip-sheets]    # Sheets 認証なしでも実行可
  [--skip-github]    # GitHub 認証なしでも実行可
  [--notion]
```

**出力**: `planning/outputs/dashboard/<YYYYMMDD>.md`

---

### `weekly-report` — 週次レポート・振り返りの自動化

> ⚠️ 出力は案件機微情報を含みます。Notion push 時の共有範囲に注意してください。

**集計対象**: 各 GitHub リポジトリのコミット / マージ済み PR / クローズ済み Issue  
**デフォルト期間**: 過去 7 日

**CLI オプション**:

```bash
npm run weekly-report -- \
  [--projects planning/inputs/projects.md]
  [--roadmap planning/inputs/roadmap.md]
  [--since YYYY-MM-DD]    # デフォルト: 7 日前
  [--until YYYY-MM-DD]    # デフォルト: 実行日
  [--out <path>]
  [--skip-github]
  [--notion]
```

**出力**: `planning/outputs/weekly/<YYYYMMDD>.md`(`--until` 日付がベース)

**将来的な定期実行**: GitHub Actions で毎週月曜朝に自動実行する構成が可能です(`.github/workflows/` への追加は今後の課題)。実装する場合は `ANTHROPIC_API_KEY`・`GITHUB_TOKEN`・Sheets サービスアカウント JSON を Actions Secrets に設定して cron で起動します。

---

## Notion 連携(オプション)

Notion 連携は全機能でオプション扱いです。`--notion` フラグで有効化し、関連環境変数が未設定の場合は警告ログを出して Markdown 出力のみで正常終了します。

### Integration の作成とトークン取得

1. `https://www.notion.so/profile/integrations` を開く
2. `+ New integration` → タイプ: **Internal** で新規作成
3. `Internal Integration Secret` を控える → `.env` の `NOTION_TOKEN` に設定
4. Integration を使うワークスペースを選択

### DB の作成手順(共通)

各 DB について以下を実施します:

1. Notion ワークスペース内に新規 Database を作成(Full page / Inline)
2. 下記「DB 構造」のプロパティを**プロパティ名・型を厳密に一致させて**追加
3. Database 右上 `...` → `Connections` → 作成した Integration を接続
4. Database URL から `databaseId` を抽出  
   `https://www.notion.so/<workspace>/<databaseId>?v=...` の 32 桁部分
5. `.env` の対応する環境変数に設定

### DB 構造一覧

#### 要件定義 DB (`NOTION_DB_REQUIREMENTS_ID`)

用途: `gen:requirements --notion` の push 先

| プロパティ名 | 型 | 値の例 |
|---|---|---|
| `Name` | title | 案件名 |
| `Client` | rich_text | 顧客名 |
| `ProjectCode` | rich_text | SAMPLE-001 |
| `Status` | select | `Draft` / `Review` / `Approved` |
| `CreatedAt` | date | 作成日 |

#### ロードマップ DB (`NOTION_DB_ROADMAP_ID`)

用途: `roadmap --notion` の push 先

| プロパティ名 | 型 | 値の例 |
|---|---|---|
| `Name` | title | Roadmap Evaluation 2026-05-12 |
| `EvaluatedAt` | date | 評価日 |
| `MilestoneCount` | number | 6 |
| `Status` | select | `Draft` / `Reviewed` |

#### リサーチ DB (`NOTION_DB_RESEARCH_ID`)

用途: `research --notion` の push 先

| プロパティ名 | 型 | 値の例 |
|---|---|---|
| `Name` | title | リサーチタイトル |
| `Market` | rich_text | 対象市場 |
| `CreatedAt` | date | 作成日 |
| `Status` | select | `Draft` / `FactChecked` |

#### 案件管理 DB (`NOTION_DB_PROJECTS_ID`)

用途: `dashboard --notion` の push 先

| プロパティ名 | 型 | 値の例 |
|---|---|---|
| `Name` | title | Dashboard 2026-05-12 |
| `GeneratedAt` | date | 生成日 |
| `ProjectCount` | number | 3 |
| `Status` | select | `Draft` / `Reviewed` |

#### 週次レポート DB (`NOTION_DB_WEEKLY_ID`)

用途: `weekly-report --notion` の push 先

| プロパティ名 | 型 | 値の例 |
|---|---|---|
| `Name` | title | Weekly 2026-05-05_2026-05-12 |
| `PeriodStart` | date | 集計開始日 |
| `PeriodEnd` | date | 集計終了日 |
| `ProjectCount` | number | 3 |
| `Status` | select | `Draft` / `Reviewed` |

### Integration 権限の注意

> ⚠️ 各 DB に接続した Integration はその DB のデータを読み書きできます。機微情報を含む DB への接続は**最小限に絞り**、ワークスペース全体への共有は避けてください。チーム共有が必要な場合は Notion 側で DB の表示権限を別途設定してください。

---

## ディレクトリ構造

```
planning/
├── README.md
├── lib/
│   ├── claude.js              # Claude API ラッパー(runPrompt / completeWithWebSearch)
│   ├── notion.js              # Notion クライアント + markdownToBlocks
│   ├── requirements-parser.js # F-XXX 形式の機能要件パーサ
│   ├── roadmap-parser.js      # M-XXX 形式のマイルストーンパーサ
│   ├── projects-parser.js     # 案件マスタパーサ
│   ├── sheets.js              # Google Sheets 薄いラッパー(googleapis)
│   └── github.js              # GitHub Octokit ラッパー(getRepoSnapshot / getRepoActivity)
├── scripts/
│   ├── gen-requirements.js    # npm run gen:requirements
│   ├── estimate.js            # npm run estimate
│   ├── research.js            # npm run research
│   ├── roadmap.js             # npm run roadmap
│   ├── dashboard.js           # npm run dashboard
│   └── weekly-report.js       # npm run weekly-report
├── templates/
│   ├── requirements.prompt.md
│   ├── estimate.prompt.md
│   ├── research.prompt.md
│   ├── roadmap.prompt.md
│   ├── dashboard.prompt.md
│   └── weekly-report.prompt.md
├── inputs/                    # 人が編集するマスタ(*.md は gitignore、*.example.md は追跡)
│   ├── roadmap.example.md
│   ├── projects.example.md
│   ├── requirements/
│   │   ├── SAMPLE-001.project.example.md
│   │   └── SAMPLE-001.hearing.example.md
│   ├── research/
│   │   └── sample.example.md
│   └── estimate/
│       └── sample.features.example.md
└── outputs/                   # 生成物(全て gitignore 済み)
    ├── requirements/
    ├── estimates/
    ├── research/
    ├── roadmap/
    ├── dashboard/
    └── weekly/
```

---

## セキュリティと注意事項

- **`planning/outputs/`** は顧客名・案件機微情報・社内未公開情報を含むため gitignore 済み。誤コミットに注意
- **`planning/inputs/*.md`** も `.example.md` 以外は gitignore 済み(入力ファイルの実体はコミットしない)
- **Notion push** は権限スコープに注意。DB 単位での Integration 接続が安全(上記参照)
- **リサーチ機能** の Web 検索ツールは Anthropic API の課金対象(`web_search_20250305`)
- **AI 生成出力はすべて補助情報**。要件定義・見積もり・リサーチ・評価は最終確認を人が行うこと

---

## 他部門との連携(将来課題)

- **要件定義 → 技術部門 `new-project`**: 要件定義 Markdown を技術部門のリポジトリ自動セットアップに渡し、要件を反映したテンプレリポを自動作成する案(現状は片方向参照のみ)
- **ロードマップ → 営業部門フォローアップ**: マイルストーン期限と顧客フォローアップタイミングを連動させる余地あり(現状は独立運用)
- **GitHub Actions による定期実行**: `weekly-report` を毎週月曜朝に自動実行する構成が可能。実装する場合は `ANTHROPIC_API_KEY`・`GITHUB_TOKEN`・Sheets サービスアカウント JSON を Actions Secrets に設定して cron で起動。営業 Sheets 連携を含める場合はサービスアカウント JSON も Secrets 化が必要
