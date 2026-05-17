'use strict';
/**
 * accounting/scripts/audit.js
 * ICHI 自動化基盤の棚卸しレポートを生成する。
 * Claude API は呼ばない。リポジトリの実ファイルから事実ベースで構築。
 *
 * 使い方:
 *   node accounting/scripts/audit.js               # Markdown + JSON 両方
 *   node accounting/scripts/audit.js --format json  # JSON のみ
 *   node accounting/scripts/audit.js --quiet         # stdout サマリを抑制
 */
const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { buildAuditReport } = require('../lib/audit');
const { pathForOutputs }   = require('../../lib/paths');
const { writeCSV }         = require('../lib/csv');

const OUTPUTS_DIR = pathForOutputs('accounting', 'audit');

// ------------------------------------------------------------------ CLI

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    format: args.includes('--format') ? args[args.indexOf('--format') + 1] : 'both',
    quiet:  args.includes('--quiet'),
  };
}

// ------------------------------------------------------------------ Markdown builder

function formatJPY(n) {
  return n == null ? '-' : '¥' + Number(n).toLocaleString('ja-JP');
}

function buildMarkdown(report) {
  const today = report.generated_at.slice(0, 10);
  const rs    = report.repo_state;
  const depts = report.departments;

  const totalFull = depts.reduce((s, d) => s + d.npm_scripts.filter(x=>x.automation_class==='fully_automated').length, 0);
  const totalAI   = depts.reduce((s, d) => s + d.npm_scripts.filter(x=>x.automation_class==='ai_assisted').length, 0);
  const totalHumanScripts = depts.reduce((s, d) => s + d.npm_scripts.filter(x=>x.automation_class==='human_only').length, 0);

  const scheduledWF = report.departments.flatMap(()=>[]).length;
  const allWF = [...new Set(depts.flatMap(d => d.workflows.map(w=>w.file)))];
  const scheduleCount = allWF.filter(f => {
    const d = depts.flatMap(d=>d.workflows).find(w=>w.file===f);
    return d && (d.trigger === 'schedule' || d.trigger === 'both');
  }).length;

  const lines = [];

  lines.push('# ICHI 自動化基盤 棚卸しレポート', '');
  lines.push(`生成日: ${today}`);
  lines.push(`対象リポジトリ: ichi-blog (機微情報: ${rs.data_repo_separated ? 'ichi-data' : 'ichi-blog (未分離)'})`);
  lines.push('');
  lines.push('> 本レポートは `accounting/scripts/audit.js` により、リポジトリの実コードと設定から');
  lines.push('> 事実ベースで生成されています。AI による推測は最小限で、原則として npm scripts /');
  lines.push('> Actions ワークフロー / README / ソースコード冒頭コメントから抽出した値を使用します。');
  lines.push('');
  lines.push('---', '', '## エグゼクティブサマリ', '');

  lines.push(`- **部門数**: ${depts.length}`);
  lines.push(`- **npm scripts**: ${rs.total_npm_scripts} 件`);
  lines.push(`- **定期実行ワークフロー**: ${rs.total_workflows} 本 (うち schedule トリガ: ${scheduleCount} 本)`);
  lines.push(`- **composite action**: ${rs.total_composite_actions} 本`);
  lines.push(`- **平均自動化率**: ${rs.average_automation_score}% (加重平均、定義は後述)`);
  lines.push(`- **機微情報の分離**: ${rs.data_repo_separated ? '完了 (ichi-data プライベートリポ)' : '未分離 (ichi-blog 配下)'}`);
  lines.push('');

  lines.push('### 部門別自動化率', '');
  lines.push('| 部門 | 自動化率 | 完全自動 | AI 補助 | 人手タスク |');
  lines.push('|---|---|---|---|---|');
  for (const d of depts) {
    const fa = d.npm_scripts.filter(s=>s.automation_class==='fully_automated').length;
    const aa = d.npm_scripts.filter(s=>s.automation_class==='ai_assisted').length;
    const ho = d.automation_status.human_only.length;
    lines.push(`| ${d.display_name} | **${d.automation_score.score}%** | ${fa} | ${aa} | ${ho} |`);
  }
  lines.push('');

  lines.push('---', '', '## 部門別詳細', '');

  for (const dept of depts) {
    const fa  = dept.npm_scripts.filter(s=>s.automation_class==='fully_automated');
    const aa  = dept.npm_scripts.filter(s=>s.automation_class==='ai_assisted');

    lines.push(`### ${dept.display_name}`, '');
    lines.push(`**自動化率**: ${dept.automation_score.score}% — ${dept.automation_score.rationale}`, '');

    if (fa.length > 0) {
      lines.push('#### 完全自動化されているタスク', '');
      lines.push('| npm script | 用途 | state 書込 | データ保管 |');
      lines.push('|---|---|---|---|');
      for (const s of fa) {
        lines.push(`| \`${s.name}\` | ${s.purpose} | ${s.state_writes ? '○' : '-'} | ${s.data_location} |`);
      }
      lines.push('');
    }

    if (aa.length > 0) {
      lines.push('#### AI 補助 + 人確認が必要なタスク', '');
      lines.push('| npm script | AI の役割 | 人が判断する内容 |');
      lines.push('|---|---|---|');
      for (const s of aa) {
        lines.push(`| \`${s.name}\` | ${s.ai_role || '-'} | ${s.human_judgment_required} |`);
      }
      lines.push('');
    }

    if (dept.automation_status.human_only.length > 0) {
      lines.push('#### 人手が必要なタスク', '');
      dept.automation_status.human_only.forEach(t => lines.push(`- ${t}`));
      lines.push('');
    }

    if (dept.automation_status.known_gaps.length > 0) {
      lines.push('#### 既知の自動化されていない領域', '');
      dept.automation_status.known_gaps.forEach(g => lines.push(`- ${g}`));
      lines.push('');
    }

    if (dept.workflows.length > 0) {
      lines.push('#### 関連 Actions ワークフロー', '');
      lines.push('| ファイル | トリガ | ichi-data 利用 |');
      lines.push('|---|---|---|');
      for (const w of dept.workflows) {
        const trig = w.cron ? `schedule (${w.cron})` : w.trigger;
        const data = w.uses_data_repo ? (w.commits_to_data_repo ? 'checkout + commit' : 'checkout のみ') : '-';
        lines.push(`| \`${path.basename(w.file)}\` | ${trig} | ${data} |`);
      }
      lines.push('');
    }
  }

  lines.push('---', '', '## 部門間連携', '');
  lines.push('| 連携元 | 連携先 | 仕組み | AI 使用 | 備考 |');
  lines.push('|---|---|---|---|---|');
  for (const c of report.cross_dept_integrations) {
    lines.push(`| ${c.from} | ${c.to} | ${c.flow} | ${c.ai_involved ? '○' : '-'} | ${c.note} |`);
  }
  lines.push('');

  lines.push('---', '', '## セキュリティ・データガバナンス', '');
  const sec = report.security;
  lines.push(`- **機微情報の保管先**: ${sec.separated_repo || 'ichi-blog (未分離)'}`);
  lines.push(`- **認証**: Fine-grained PAT (DATA_REPO_TOKEN)、ichi-data への Contents:write 権限`);
  lines.push(`- **有効期限注意**: ${sec.pat_expiry_note}`);
  lines.push(`- **保護対象パス (gitignore)**:`);
  sec.sensitive_data_paths.forEach(p => lines.push(`  - ${p}`));
  lines.push('');

  lines.push('---', '', '## 既知の課題', '');
  const byPriority = { high: [], medium: [], low: [] };
  for (const issue of report.known_issues) {
    byPriority[issue.severity].push(issue);
  }
  for (const [sev, issues] of Object.entries(byPriority)) {
    if (issues.length === 0) continue;
    lines.push(`### ${sev === 'high' ? '🔴 高優先度' : sev === 'medium' ? '🟡 中優先度' : '🟢 低優先度'}`, '');
    for (const issue of issues) {
      lines.push(`**${issue.title}**`);
      lines.push(issue.description);
      if (issue.affected_workflows.length > 0) {
        lines.push(`対象: ${issue.affected_workflows.join(', ')}`);
      }
      lines.push('');
    }
  }

  lines.push('---', '', '## 将来課題候補', '');
  lines.push('| タイトル | 規模感 | 概要 |');
  lines.push('|---|---|---|');
  for (const fc of report.future_candidates) {
    lines.push(`| ${fc.title} | ${fc.estimated_effort} | ${fc.rationale} |`);
  }
  lines.push('');

  lines.push('---', '', '## 自動化率の算出方法', '');
  lines.push('各部門について以下の加重平均で算出:', '');
  lines.push('```');
  lines.push('score = (完全自動 × 1.0 + AI 補助 × 0.7 + 人手 × 0) ÷ npm_scripts 数 × 100');
  lines.push('```');
  lines.push('');
  lines.push('**重み 0.7 の根拠**: AI が初期判断を行うため作業時間は完全人手の約 30% に短縮されるが、最終確認は人が必要なため 100% にはしない。');
  lines.push('');
  lines.push('**分類基準**:');
  lines.push('- 完全自動: スクリプト実行のみで結果が確定 (PDF 生成、数値計算、ファイル集約)');
  lines.push('- AI 補助: Claude API を呼ぶ箇所がある、または needs_review フラグが出力に含まれる');
  lines.push('- 人手: npm scripts に該当なし（本レポートでは現状 0 件）');
  lines.push('');
  lines.push('---');
  lines.push(`生成元: accounting/scripts/audit.js`);
  lines.push(`再生成: npm run audit`);

  return lines.join('\n');
}

// ------------------------------------------------------------------ main

async function main() {
  const { format, quiet } = parseArgs();
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  if (!quiet) console.log('自動化棚卸しレポート生成中...');

  const report = await buildAuditReport();

  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

  const base     = `automation-coverage-${today}`;
  const mdPath   = path.resolve(OUTPUTS_DIR, `${base}.md`);
  const jsonPath = path.resolve(OUTPUTS_DIR, `${base}.json`);

  if (format !== 'json') {
    const md = buildMarkdown(report);
    fs.writeFileSync(mdPath, md, 'utf8');
    if (!quiet) console.log(`Markdown: ${mdPath}`);
  }

  if (format !== 'markdown') {
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    if (!quiet) console.log(`JSON:     ${jsonPath}`);
  }

  if (!quiet) {
    const rs = report.repo_state;
    console.log('\n── エグゼクティブサマリ ──');
    console.log(`npm scripts: ${rs.total_npm_scripts} / workflows: ${rs.total_workflows} / composite: ${rs.total_composite_actions}`);
    console.log(`平均自動化率: ${rs.average_automation_score}%`);
    console.log(`機微情報分離: ${rs.data_repo_separated ? '完了 (ichi-data)' : '未分離'}`);
    console.log('');
    console.log('部門別:');
    for (const d of report.departments) {
      const fa = d.npm_scripts.filter(s=>s.automation_class==='fully_automated').length;
      const aa = d.npm_scripts.filter(s=>s.automation_class==='ai_assisted').length;
      console.log(`  ${d.display_name.padEnd(22)} ${String(d.automation_score.score).padStart(3)}%  (完全自動 ${fa} / AI補助 ${aa})`);
    }
  }
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
