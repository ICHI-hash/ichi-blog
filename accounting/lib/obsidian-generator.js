'use strict';
/**
 * accounting/lib/obsidian-generator.js
 * Obsidian Vault のノート群を buildAuditReport() のデータから生成する。
 * Claude API は呼ばない。audit.js の出力を再利用するのみ。
 */
const fs   = require('fs');
const path = require('path');
const matter = require('gray-matter');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { buildAuditReport }       = require('./audit');
const { buildSummary: taxSummary } = require('./tax-rates-summary');
const { resolveVaultDir, vaultPath } = require('../../lib/obsidian-vault');

const REPO_ROOT = path.resolve(__dirname, '../..');
const WF_DIR    = path.resolve(REPO_ROOT, '.github/workflows');

// ------------------------------------------------------------------ helpers

function toJSTISOString() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00');
}

function readText(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; }
}

function safeFilename(name) {
  return name.replace(/:/g, '-').replace(/[/\\?%*|"<>]/g, '-');
}

function cronToHuman(cron) {
  if (!cron) return '手動のみ';
  const map = {
    '0 0 * * *':   '毎日 09:00 JST',
    '30 0 * * *':  '毎日 09:30 JST',
    '0 0 * * 1':   '毎週月曜 09:00 JST',
    '0 0 5 * *':   '毎月 5 日 09:00 JST',
    '0 0 1 4 *':   '毎年 4 月 1 日 09:00 JST',
    '0 3 * * 1-5': '月〜金 12:00 JST',
    '0 23 * * 0':  '毎週日曜 08:00 JST',
  };
  return map[cron] || cron;
}

function front(data, body) {
  const lines = ['---'];
  lines.push(`auto_generated: true`);
  lines.push(`last_generated: "${toJSTISOString()}"`);
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(x => JSON.stringify(x)).join(', ')}]`);
    } else if (typeof v === 'string') {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n\n' + body;
}

// ------------------------------------------------------------------ workflow helpers

function collectWorkflowFiles() {
  let files = [];
  try { files = fs.readdirSync(WF_DIR).filter(f => f.endsWith('.yml')); } catch { return []; }
  return files.map(file => {
    const content = readText(path.resolve(WF_DIR, file));
    const nameMatch = content.match(/^name:\s+(.+)$/m);
    const wfName = nameMatch ? nameMatch[1].trim() : path.basename(file, '.yml');
    const cronMatch = content.match(/cron:\s+"([^"]+)"/);
    const cron = cronMatch ? cronMatch[1] : null;
    const scriptCalls = [...content.matchAll(/npm run ([^\s\n]+)/g)].map(m => m[1]);
    const secrets = [...content.matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1]);
    const usesData   = content.includes('checkout-data-repo');
    const commitsData = content.includes('commit-data-changes');
    return {
      file,
      baseName: path.basename(file, '.yml'),
      wfName,
      cron,
      cronHuman: cronToHuman(cron),
      hasSch:   Boolean(cron),
      hasDsp:   content.includes('workflow_dispatch'),
      scriptCalls: [...new Set(scriptCalls)],
      secrets:  [...new Set(secrets)].sort(),
      usesData,
      commitsData,
      content,
    };
  });
}

/** スクリプト名からそれを呼ぶワークフロー一覧を返す */
function workflowsForScript(scriptName, wfFiles) {
  return wfFiles.filter(w => w.scriptCalls.includes(scriptName));
}

/** ワークフローが属する部門を audit から逆引き */
function deptForWorkflow(baseName, audit) {
  for (const d of audit.departments) {
    if (d.workflows.some(w => path.basename(w.file, '.yml') === baseName)) {
      return d;
    }
  }
  return null;
}

// ------------------------------------------------------------------ env-vars parser

function parseEnvExample() {
  const text = readText(path.resolve(REPO_ROOT, '.env.example'));
  const lines = text.split('\n');
  const vars = [];
  let pendingComment = '';
  for (const line of lines) {
    if (line.startsWith('#')) {
      pendingComment = line.replace(/^#+\s*/, '').replace(/─+/g, '').trim();
    } else if (line.includes('=')) {
      const [key] = line.split('=');
      if (key.trim()) {
        vars.push({ key: key.trim(), comment: pendingComment });
        pendingComment = '';
      }
    } else {
      if (!line.trim()) pendingComment = '';
    }
  }
  return vars;
}

// ------------------------------------------------------------------ note builders

function buildIndexNote(audit) {
  const rs = audit.repo_state;
  const depts = audit.departments;

  const deptLinks = depts.map(d =>
    `- [[01-departments/${d.id}|${d.display_name}]] **${d.automation_score.score}%**`
  ).join('\n');

  return front(
    { tags: ['ichi', 'index'] },
    `# ICHI 自動化基盤

> このノートは \`npm run obsidian:sync\` で自動更新されます。

## 概要

| 項目 | 値 |
|---|---|
| 部門数 | ${depts.length} |
| npm scripts | ${rs.total_npm_scripts} 件 |
| ワークフロー | ${rs.total_workflows} 本 |
| composite action | ${rs.total_composite_actions} 本 |
| 平均自動化率 | **${rs.average_automation_score}%** |
| 機微情報分離 | ${rs.data_repo_separated ? '完了 (ichi-data)' : '未分離'} |

## 部門

${deptLinks}

## ダッシュボード

- [[05-dashboard/today|今日の状況]]
- [[05-dashboard/automation-coverage|自動化カバレッジ]]
- [[05-dashboard/pending-attention|要対応一覧]]
- [[05-dashboard/recent-activity|直近の更新]]

## データフロー

- [[04-data-flows/monthly-cycle|月次業務サイクル]]
- [[04-data-flows/invoice-to-payment-flow|請求 → 入金フロー]]
- [[04-data-flows/expense-to-tax-package-flow|経費 → 税理士提出フロー]]
- [[04-data-flows/cross-dept-integration|部門間連携]]
- [[04-data-flows/data-storage-architecture|データ保管構成]]

## リファレンス

- [[06-reference/env-vars|環境変数]]
- [[06-reference/secrets|GitHub Secrets]]
- [[06-reference/tax-rates|税率一覧]]
`
  );
}

function buildDepartmentNote(dept, audit) {
  const fa  = dept.npm_scripts.filter(s => s.automation_class === 'fully_automated');
  const aa  = dept.npm_scripts.filter(s => s.automation_class === 'ai_assisted');
  const hum = dept.automation_status.human_only;
  const gaps = dept.automation_status.known_gaps;

  const faLinks = fa.map(s =>
    `- [[02-scripts/${safeFilename(s.name)}|${s.name}]]: ${s.purpose}`
  ).join('\n');

  const aaLinks = aa.map(s =>
    `- [[02-scripts/${safeFilename(s.name)}|${s.name}]]: ${s.purpose}`
  ).join('\n');

  const wfLinks = dept.workflows.map(w => {
    const baseName = path.basename(w.file, '.yml');
    return `- [[03-workflows/${baseName}|${baseName}]]`;
  }).join('\n');

  const humList = hum.map(t => `- ${t}`).join('\n');
  const gapList = gaps.map(g => `- ${g}`).join('\n');

  return front(
    {
      department:       dept.id,
      display_name:     dept.display_name,
      automation_score: dept.automation_score.score,
      tags:             ['ichi', 'department', dept.id],
    },
    `# ${dept.display_name}

[[00-index|ICHI 自動化基盤]] > ${dept.display_name}

自動化率: **${dept.automation_score.score}%** (完全自動 ${fa.length} / AI 補助 ${aa.length})

> ${dept.automation_score.rationale}

## 完全自動化されているタスク

${fa.length > 0 ? faLinks : '(なし)'}

## AI 補助 + 人確認が必要なタスク

${aa.length > 0 ? aaLinks : '(なし)'}

## 関連ワークフロー

${dept.workflows.length > 0 ? wfLinks : '(なし)'}

## 人が行うタスク

${humList || '(未記載)'}

## 既知の自動化ギャップ

${gapList || '(なし)'}
`
  );
}

function buildScriptNote(scriptData, wfFiles) {
  const relatedWfs = workflowsForScript(scriptData.name, wfFiles);
  const wfLinks = relatedWfs.map(w =>
    `- [[03-workflows/${w.baseName}|${w.wfName}]]`
  ).join('\n');

  const classLabel = {
    fully_automated: '完全自動',
    ai_assisted:     'AI 補助',
    human_only:      '人手',
  }[scriptData.automation_class] || scriptData.automation_class;

  return front(
    {
      script_name:    scriptData.name,
      department:     scriptData.dept,
      category:       scriptData.automation_class,
      ai_used:        scriptData.ai_used,
      state_writes:   scriptData.state_writes,
      data_location:  scriptData.data_location,
      tags:           ['ichi', 'script', scriptData.dept, scriptData.automation_class.replace(/_/g, '-')],
    },
    `# ${scriptData.name}

[[01-departments/${scriptData.dept}|${scriptData.dept}]] > ${classLabel}

## 用途

${scriptData.purpose}

## 実行方法

\`\`\`bash
npm run ${scriptData.name}
\`\`\`

## 内部構成

| 項目 | 値 |
|---|---|
| エントリポイント | \`${scriptData.entry}\` |
| Claude API | ${scriptData.ai_used ? '使用する' : '使用しない'} |
| State 書き込み | ${scriptData.state_writes ? 'あり' : 'なし'} |
| データ保管 | ${scriptData.data_location} |

${scriptData.ai_used ? `## AI の役割\n\n${scriptData.ai_role || '(詳細は README 参照)'}\n` : ''}
## 人が判断する内容

${scriptData.human_judgment_required}

## 関連ワークフロー

${relatedWfs.length > 0 ? wfLinks : '(なし)'}
`
  );
}

function buildWorkflowNote(wfFile, dept) {
  const triggers = [];
  if (wfFile.hasSch) triggers.push(`schedule: ${wfFile.cronHuman} (\`${wfFile.cron}\`)`);
  if (wfFile.hasDsp) triggers.push('workflow_dispatch: 手動実行');

  const scriptLinks = wfFile.scriptCalls.map(s =>
    `- [[02-scripts/${safeFilename(s)}|${s}]]`
  ).join('\n');

  const secretsList = wfFile.secrets.map(s => `- \`${s}\``).join('\n');

  const dataRepoStatus = wfFile.usesData
    ? (wfFile.commitsData ? 'checkout + commit' : 'checkout のみ')
    : '利用しない';

  return front(
    {
      workflow_file:        wfFile.file,
      department:           dept ? dept.id : 'unknown',
      schedule:             wfFile.cron || null,
      uses_data_repo:       wfFile.usesData,
      commits_to_data_repo: wfFile.commitsData,
      tags:                 ['ichi', 'workflow', dept ? dept.id : 'common'],
    },
    `# ${wfFile.wfName}

${dept ? `[[01-departments/${dept.id}|${dept.display_name}]] のワークフロー` : '共通ワークフロー'}

## トリガ

${triggers.map(t => `- ${t}`).join('\n')}

## 連動スクリプト

${wfFile.scriptCalls.length > 0 ? scriptLinks : '(なし)'}

## データリポ (ichi-data) 連携

${dataRepoStatus}

## 必要な GitHub Secrets

${secretsList || '(なし)'}

## GitHub Actions

[このワークフローを Actions で見る](https://github.com/ICHI-hash/ichi-blog/actions/workflows/${wfFile.file})
`
  );
}

function buildDataFlowNotes(audit) {
  const now = toJSTISOString();

  const monthlyCycle = front(
    { tags: ['ichi', 'dataflow', 'monthly'] },
    `# 月次業務サイクル

月初から月末までの ICHI の業務フロー (経理を中心に)。

\`\`\`mermaid
flowchart LR
  A["請求書発行\\nnpm run invoice"] --> B["入金消込\\nnpm run reconcile"]
  B --> C["経費仕訳\\nnpm run categorize"]
  C --> D["月次レポート\\nnpm run monthly-report"]
  D --> E["税理士パッケージ\\nnpm run tax-package"]
  F["支払予定\\nnpm run payments"] -."毎朝 09:00".-> G[("Gmail 通知")]
  H["領収書取得\\nnpm run fetch-receipts"] -."毎週月曜".-> C
  I["営業受注連携\\nnpm run sync-from-sales"] -."毎朝 09:30".-> A
\`\`\`

## 各ステップへのリンク

- [[02-scripts/invoice]]
- [[02-scripts/reconcile]]
- [[02-scripts/categorize]]
- [[02-scripts/monthly-report]]
- [[02-scripts/tax-package]]
- [[02-scripts/payments]]
- [[02-scripts/fetch-receipts]]
- [[02-scripts/sync-from-sales]]
`
  );

  const invoiceFlow = front(
    { tags: ['ichi', 'dataflow', 'invoice'] },
    `# 請求 → 入金フロー

\`\`\`mermaid
flowchart TD
  A["営業: 受注確定\\nsync-from-sales"] --> B["経理: 請求書下書き生成\\ndraft-YYYYMMDD-xxx.md"]
  B --> C["人: 内容確認・金額入力"]
  C --> D["人: npm run invoice"]
  D --> E["PDF + meta.json 生成\\nichi-data/accounting/outputs/invoices/"]
  E --> F["入金消込 reconcile"]
  F --> G["消込確定\\nstate/reconciled.json"]
\`\`\`

## 関連ノート

- [[02-scripts/sync-from-sales]]
- [[02-scripts/invoice]]
- [[02-scripts/reconcile]]
`
  );

  const expenseFlow = front(
    { tags: ['ichi', 'dataflow', 'expense'] },
    `# 経費 → 税理士提出フロー

\`\`\`mermaid
flowchart TD
  A["人: 銀行 CSV ダウンロード"] --> B["categorize: AI 仕訳"]
  C["fetch-receipts: Gmail OCR"] --> D["receipts-index.json"]
  B --> E["entries.csv"]
  D --> E
  E --> F["monthly-report: 月次レポート"]
  F --> G["tax-package: 税理士パッケージ"]
  G --> H["人: checklist.md 確認"]
  H --> I["税理士へ送付"]
\`\`\`

## 関連ノート

- [[02-scripts/categorize]]
- [[02-scripts/fetch-receipts]]
- [[02-scripts/monthly-report]]
- [[02-scripts/tax-package]]
`
  );

  const crossDept = front(
    { tags: ['ichi', 'dataflow', 'cross-dept'] },
    `# 部門間連携

\`\`\`mermaid
flowchart LR
  subgraph sales["営業"]
    S1["パイプライン\\n(ichi-data)"]
    S2["sales:reminder\\n毎朝 09:00"]
    S3["sync-from-sales\\n毎朝 09:30"]
  end
  subgraph accounting["経理"]
    A1["請求書下書き\\n(ichi-data)"]
    A2["invoice → PDF"]
  end
  subgraph common["共通基盤"]
    LM["lib/mailer.js\\nGmail 送信"]
    LP["lib/paths.js\\nパス解決"]
  end
  S3 --> A1
  A1 --> A2
  S2 --> LM
  A2 --> LM
\`\`\`

## 連携詳細

${audit.cross_dept_integrations.map(c =>
  `### ${c.from} → ${c.to}\n- フロー: ${c.flow}\n- スクリプト: ${c.script}\n- AI: ${c.ai_involved ? 'あり' : 'なし'}\n- 備考: ${c.note}`
).join('\n\n')}
`
  );

  const dataArch = front(
    { tags: ['ichi', 'dataflow', 'architecture'] },
    `# データ保管構成

\`\`\`mermaid
flowchart TB
  subgraph local["ローカル開発"]
    ichiBlog["ichi-blog\\nコード"]
    dataLink["ichi-blog/data\\nシンボリックリンク"]
    ichiData["ichi-data\\n機微データ (Private)"]
    ichiBlog -."INPUT/STATE_BASE_DIR=./data".-> dataLink
    dataLink -."物理実体".-> ichiData
  end
  subgraph cloud["GitHub Actions"]
    cloneCode["ichi-blog clone"]
    cloneData["ichi-data clone\\n(./data)"]
    cloneCode -."checkout-data-repo".-> cloneData
    cloneData -."commit-data-changes".-> ichiData
  end
\`\`\`

## ディレクトリ対応

| 用途 | ローカル | Actions |
|---|---|---|
| 入力データ | \`data/accounting/inputs/\` | \`data/accounting/inputs/\` |
| 状態ファイル | \`data/accounting/state/\` | \`data/accounting/state/\` |
| 出力ファイル | \`data/accounting/outputs/\` | \`data/accounting/outputs/\` |
| 営業パイプライン | \`data/sales/inputs/pipeline/\` | \`data/sales/inputs/pipeline/\` |

## 関連ノート

- [[06-reference/env-vars]]
- [[06-reference/secrets]]
`
  );

  return [
    { path: '04-data-flows/monthly-cycle.md',             content: monthlyCycle },
    { path: '04-data-flows/invoice-to-payment-flow.md',   content: invoiceFlow },
    { path: '04-data-flows/expense-to-tax-package-flow.md', content: expenseFlow },
    { path: '04-data-flows/cross-dept-integration.md',    content: crossDept },
    { path: '04-data-flows/data-storage-architecture.md', content: dataArch },
  ];
}

function buildDashboardNotes(audit) {
  const rs = audit.repo_state;

  const today = front(
    { tags: ['ichi', 'dashboard'] },
    `# 今日の状況

> Dataview プラグインが必要です。Obsidian 設定 > コミュニティプラグイン から有効化してください。

## 毎日実行されるワークフロー

\`\`\`dataview
TABLE without id
  workflow_file as "ファイル",
  schedule as "スケジュール",
  department as "部門"
FROM "03-workflows"
WHERE uses_data_repo = true
SORT workflow_file ASC
\`\`\`

## 要確認タスク

- 支払予定 (前日の payments 実行結果を確認)
- 消込候補 (reconcile の提案 Markdown を確認)
- 経費仕訳要確認 (categorize の summary.md を確認)
- 領収書 OCR 要確認 (週次の fetch-receipts 実行後)

## リンク

- [[05-dashboard/automation-coverage|自動化カバレッジ]]
- [[05-dashboard/pending-attention|要対応一覧]]
- [[04-data-flows/monthly-cycle|月次業務サイクル]]
`
  );

  const issues = audit.known_issues.map(i =>
    `- **[${i.severity.toUpperCase()}]** ${i.title}: ${i.description}`
  ).join('\n');
  const future = audit.future_candidates.map(f =>
    `- **[${f.estimated_effort}]** ${f.title}: ${f.rationale}`
  ).join('\n');

  const coverage = front(
    { tags: ['ichi', 'dashboard'] },
    `# 自動化カバレッジ

平均自動化率: **${rs.average_automation_score}%** (加重平均)

## 部門別自動化率

\`\`\`dataview
TABLE without id
  display_name as "部門",
  automation_score as "自動化率 (%)"
FROM "01-departments"
SORT automation_score DESC
\`\`\`

## スクリプト分類

\`\`\`dataview
TABLE without id
  category as "分類",
  length(rows) as "件数"
FROM "02-scripts"
GROUP BY category
\`\`\`

## 既知の課題

${issues || '(なし)'}

## 将来課題候補

${future || '(なし)'}
`
  );

  const pending = front(
    { tags: ['ichi', 'dashboard'] },
    `# 要対応一覧

AI 補助または人手が必要なスクリプト一覧。

\`\`\`dataview
TABLE without id
  file.link as "スクリプト",
  department as "部門",
  category as "分類",
  ai_used as "AI"
FROM "02-scripts"
WHERE category = "ai_assisted" OR category = "human_only"
SORT department ASC
\`\`\`

## 確認すべき出力

- 月次: \`ichi-data/accounting/outputs/monthly-reports/\`
- 消込提案: \`ichi-data/accounting/outputs/reconcile/\`
- 仕訳サマリ: \`ichi-data/accounting/outputs/categorize/\`
- 受取リマインダー: \`ichi-data/accounting/outputs/payments/\`
`
  );

  const recentActivity = front(
    { tags: ['ichi', 'dashboard'] },
    `# 直近の更新

最後の Vault 生成: \`${toJSTISOString()}\`

次の定期実行:

| ワークフロー | スケジュール |
|---|---|
| accounting-payments | 毎日 09:00 JST |
| sales-morning-reminder | 毎日 09:00 JST |
| sync-from-sales | 毎日 09:30 JST |
| accounting-fetch-receipts | 毎週月曜 09:00 JST |
| accounting-monthly-report | 毎月 5 日 09:00 JST |
| tax-rates-annual-check | 毎年 4 月 1 日 09:00 JST |

---

*再生成: \`npm run obsidian:sync\`*
`
  );

  return [
    { path: '05-dashboard/today.md',               content: today },
    { path: '05-dashboard/automation-coverage.md',  content: coverage },
    { path: '05-dashboard/pending-attention.md',    content: pending },
    { path: '05-dashboard/recent-activity.md',      content: recentActivity },
  ];
}

function buildReferenceNotes(audit) {
  // env-vars from .env.example
  const envVars = parseEnvExample();
  const envTable = envVars.map(v =>
    `| \`${v.key}\` | ${v.comment || '-'} |`
  ).join('\n');

  const envNote = front(
    { tags: ['ichi', 'reference', 'env'] },
    `# 環境変数

\`.env\` / GitHub Secrets で管理する変数の一覧。

## 変数一覧

| 変数名 | 説明 |
|---|---|
${envTable}

## ローカル設定 (.env)

\`\`\`bash
# ichi-blog/.env に設定
ANTHROPIC_API_KEY=...
INPUT_BASE_DIR=./data
STATE_BASE_DIR=./data
OUTPUT_BASE_DIR=./data
OBSIDIAN_VAULT_DIR=/path/to/vault
\`\`\`

## 関連ノート

- [[06-reference/secrets|GitHub Secrets]]
`
  );

  // secrets from all workflows
  const allSecrets = [...new Set(
    audit.departments.flatMap(d => d.workflows.flatMap(w => w.secrets_required || []))
  )].sort();

  const secretsNote = front(
    { tags: ['ichi', 'reference', 'secrets'] },
    `# GitHub Secrets

リポジトリ Settings → Secrets and variables → Actions で管理。

## 登録済み Secrets (値は持たない、名前と用途のみ)

| Secret 名 | 用途 |
|---|---|
| \`ANTHROPIC_API_KEY\` | Claude API キー (全部門共通) |
| \`GMAIL_CLIENT_ID\` | Gmail API OAuth2 クライアント ID |
| \`GMAIL_CLIENT_SECRET\` | Gmail API OAuth2 クライアントシークレット |
| \`GMAIL_REFRESH_TOKEN\` | Gmail API リフレッシュトークン (gmail.send + gmail.readonly) |
| \`GMAIL_USER\` | 送信元 Gmail アドレス |
| \`BUSINESS_NOTIFY_EMAIL\` | 通知先メールアドレス |
| \`DATA_REPO_FULL_NAME\` | ichi-data リポジトリのフルネーム |
| \`DATA_REPO_TOKEN\` | ichi-data への PAT (Contents:write, 90 日有効) |
| \`NOTION_TOKEN\` | Notion Integration Secret |
| \`NOTION_DB_MONTHLY_REPORT_ID\` | 月次レポート DB の ID |
| \`SALES_SHEET_ID\` | 営業 Sheets ID (任意) |
| \`TAX_STATUS\` / \`TAX_METHOD\` / \`TAX_BUSINESS_CATEGORY\` | 消費税設定 |

## 注意事項

- DATA_REPO_TOKEN は **90 日で有効期限**。期限切れで全 Actions が失敗する
- PAT 失効リマインダーは未実装 (将来課題)
- Secrets は GitHub UI から手動登録が必要

## 関連ノート

- [[06-reference/env-vars|環境変数]]
`
  );

  // tax-rates from tax-rates-summary.js
  let taxNote;
  try {
    const ts = taxSummary();
    const brackets = ts.rates.income_brackets.map((b, i) =>
      `| 第 ${i+1} 段階 | ${b.limit ? b.limit.toLocaleString('ja-JP') + ' 円以下' : '無制限'} | ${b.rate} | ${b.deduction.toLocaleString('ja-JP')} 円 |`
    ).join('\n');
    const simpleRates = ts.rates.consumption_simple_categories.map(c =>
      `| 第 ${c.code} 種 | ${c.name} | ${c.rate} |`
    ).join('\n');

    taxNote = front(
      { tags: ['ichi', 'reference', 'tax'], last_updated: ts.last_updated },
      `# 税率一覧

ソース: \`accounting/lib/tax-rates.js\` + \`tax-estimate.js\`
最終更新: ${ts.last_updated}

> ⚠️ 税務申告・確定申告の最終確認は必ず税理士に依頼してください。

## 消費税

| 区分 | 税率 |
|---|---|
| 標準税率 | ${ts.rates.consumption_standard}% |
| 軽減税率 | ${ts.rates.consumption_reduced}% |

## 源泉徴収

| 区分 | 税率 |
|---|---|
| 閾値以下 (${ts.rates.withholding_threshold.toLocaleString('ja-JP')} 円以下) | ${ts.rates.withholding_low_rate_pct} |
| 閾値超過 | ${ts.rates.withholding_high_rate_pct} + ${ts.rates.withholding_base_amount.toLocaleString('ja-JP')} 円 |

## 所得税 (超過累進)

| 段階 | 上限 | 税率 | 控除額 |
|---|---|---|---|
${brackets}

## 住民税

一律 ${ts.rates.resident_tax_rate} (均等割除く)

## 簡易課税みなし仕入率

| 区分 | 業種 | 仕入率 |
|---|---|---|
${simpleRates}

## 年次チェック

[[03-workflows/tax-rates-annual-check|tax-rates-annual-check]] が毎年 4 月 1 日に Issue を自動起票します。
改正があれば \`accounting/lib/tax-rates.js\` と \`tax-estimate.js\` を更新してください。

## リファレンス URL

${ts.references.map(r => `- [${r.title}](${r.url})`).join('\n')}
`
    );
  } catch (e) {
    taxNote = front(
      { tags: ['ichi', 'reference', 'tax'] },
      `# 税率一覧\n\n⚠️ 税率データの読み込みに失敗しました: ${e.message}\n`
    );
  }

  return [
    { path: '06-reference/env-vars.md', content: envNote },
    { path: '06-reference/secrets.md',  content: secretsNote },
    { path: '06-reference/tax-rates.md', content: taxNote },
  ];
}

function parseEnvExample() {
  const text = readText(path.resolve(REPO_ROOT, '.env.example'));
  const lines = text.split('\n');
  const vars = [];
  let desc = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      const comment = trimmed.replace(/^#+\s*/, '').replace(/[─\-]+/g, '').trim();
      if (comment) desc = comment;
    } else if (trimmed.includes('=')) {
      const key = trimmed.split('=')[0].trim();
      if (key && !key.startsWith('#')) {
        vars.push({ key, comment: desc });
        desc = '';
      }
    } else if (!trimmed) {
      desc = '';
    }
  }
  return vars;
}

function buildObsidianConfig() {
  const communityPlugins = JSON.stringify(['dataview', 'templater-obsidian'], null, 2);
  const corePlugins = JSON.stringify([
    'file-explorer', 'global-search', 'switcher', 'graph',
    'backlink', 'outgoing-link', 'tag-pane', 'page-preview',
    'templates', 'note-composer', 'command-palette',
    'markdown-importer', 'outline', 'word-count', 'file-recovery',
  ], null, 2);
  const appJson = JSON.stringify({
    alwaysUpdateLinks:  true,
    showInlineTitle:    true,
    newLinkFormat:      'shortest',
    useMarkdownLinks:   false,
  }, null, 2);

  return [
    { path: '.obsidian/community-plugins.json', content: communityPlugins + '\n' },
    { path: '.obsidian/core-plugins.json',       content: corePlugins + '\n' },
    { path: '.obsidian/app.json',                content: appJson + '\n' },
  ];
}

// ------------------------------------------------------------------ auto-generated check

function isAutoGenerated(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const parsed = matter(content);
    if (!parsed.data || Object.keys(parsed.data).length === 0) return false;
    return parsed.data.auto_generated !== false;
  } catch {
    return true; // ファイルなし → 新規作成対象
  }
}

// ------------------------------------------------------------------ main API

/**
 * Vault 全体のノート群を生成する。
 * @param {{ dryRun?: boolean, verbose?: boolean, force?: boolean }} opts
 * @returns {{ created: string[], updated: string[], skipped: string[] }}
 */
async function generateVault({ dryRun = false, verbose = false, force = false } = {}) {
  const audit    = await buildAuditReport();
  const wfFiles  = collectWorkflowFiles();

  // 全ノートを収集
  const notes = [];

  // 00-index
  notes.push({ path: '00-index.md', content: buildIndexNote(audit) });

  // 01-departments
  for (const dept of audit.departments) {
    notes.push({
      path:    `01-departments/${dept.id}.md`,
      content: buildDepartmentNote(dept, audit),
    });
  }

  // 02-scripts (dept 情報を保持するため department ごとに展開)
  for (const dept of audit.departments) {
    for (const s of dept.npm_scripts) {
      notes.push({
        path:    `02-scripts/${safeFilename(s.name)}.md`,
        content: buildScriptNote({ ...s, dept: dept.id }, wfFiles),
      });
    }
  }

  // 03-workflows
  for (const wf of wfFiles) {
    const dept = deptForWorkflow(wf.baseName, audit);
    notes.push({
      path:    `03-workflows/${wf.baseName}.md`,
      content: buildWorkflowNote(wf, dept),
    });
  }

  // 04-data-flows
  notes.push(...buildDataFlowNotes(audit));

  // 05-dashboard
  notes.push(...buildDashboardNotes(audit));

  // 06-reference
  notes.push(...buildReferenceNotes(audit));

  // .obsidian/
  notes.push(...buildObsidianConfig());

  // 書き込み
  const created = [], updated = [], skipped = [];

  for (const note of notes) {
    const fullPath = vaultPath(note.path);

    if (dryRun) {
      created.push(note.path);
      if (verbose) console.log(`  [DRY RUN] ${note.path}`);
      continue;
    }

    const exists = fs.existsSync(fullPath);

    if (exists && !force && !isAutoGenerated(fullPath)) {
      skipped.push(note.path);
      if (verbose) console.warn(`  スキップ (手書きノート): ${note.path}`);
      continue;
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, note.content, 'utf8');

    if (exists) {
      updated.push(note.path);
      if (verbose) console.log(`  更新: ${note.path}`);
    } else {
      created.push(note.path);
      if (verbose) console.log(`  作成: ${note.path}`);
    }
  }

  return { created, updated, skipped };
}

module.exports = {
  generateVault,
  buildIndexNote,
  buildDepartmentNote,
  buildScriptNote,
  buildWorkflowNote,
  buildDataFlowNotes,
  buildDashboardNotes,
  buildReferenceNotes,
  buildObsidianConfig,
};
