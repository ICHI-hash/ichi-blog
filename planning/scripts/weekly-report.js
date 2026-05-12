'use strict';

const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseArgs } = require('node:util');
const { runPrompt }       = require('../lib/claude.js');
const { parseProjects }   = require('../lib/projects-parser.js');
const { parseRoadmap }    = require('../lib/roadmap-parser.js');
const github              = require('../lib/github.js');
const notion              = require('../lib/notion.js');

const OUTPUTS_DIR      = resolve(__dirname, '../outputs/weekly');
const PROJECTS_DEFAULT = resolve(__dirname, '../inputs/projects.md');
const ROADMAP_DEFAULT  = resolve(__dirname, '../inputs/roadmap.md');
const TEMPLATE_PATH    = resolve(__dirname, '../templates/weekly-report.prompt.md');

// ── Utilities ──────────────────────────────────────────────────────────────

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

// YYYY-MM-DD → ISO 8601(since は 00:00:00Z、until は 23:59:59Z)
function parseDateToIso(dateStr, endOfDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`日付は YYYY-MM-DD 形式で指定してください: "${dateStr}"`);
  }
  return endOfDay ? `${dateStr}T23:59:59Z` : `${dateStr}T00:00:00Z`;
}

// until 日付のコンパクト形式をベースに連番付きパス生成
function resolveOutPath(dir, untilDate) {
  mkdirSync(dir, { recursive: true });
  const base = untilDate.replace(/-/g, '');
  let path = resolve(dir, `${base}.md`);
  let n = 2;
  while (existsSync(path)) { path = resolve(dir, `${base}-${n}.md`); n++; }
  return path;
}

// PR / Issue タイトル一覧(最大 maxItems 件、超過時は「... 他 N 件」を末尾に追加)
function listTitles(items, label, maxItems = 10) {
  if (items.length === 0) return `${label}: なし`;
  const shown = items.slice(0, maxItems).map((it, i) =>
    `${i + 1}. #${it.number} ${it.title} (${it.mergedAt ?? it.closedAt}, ${it.author})`
  );
  if (items.length > maxItems) shown.push(`... 他 ${items.length - maxItems} 件`);
  return `${label}:\n${shown.map(l => `  - ${l}`).join('\n')}`;
}

// ── Data collection ────────────────────────────────────────────────────────

async function collectProjectActivity(project, { since, until, skipGithub }) {
  const result = {
    project,
    repoActivities: [],  // per-repo activity or error
    totals: { commitCount: 0, mergedPRCount: 0, closedIssueCount: 0, contributors: new Set() },
    allMergedPRs: [],
    allClosedIssues: [],
  };

  if (project.repos.length === 0) {
    result.repoActivities = [{ repo: null, status: 'no_repos' }];
    return result;
  }

  for (const repoStr of project.repos) {
    if (skipGithub) {
      result.repoActivities.push({ repo: repoStr, status: 'skipped' });
      continue;
    }
    const parts = repoStr.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      result.repoActivities.push({ repo: repoStr, status: 'error', error: '不正な形式 (owner/repo)' });
      continue;
    }
    const activity = await github.getRepoActivity(parts[0], parts[1], { since, until });
    result.repoActivities.push({ repo: repoStr, status: activity.error ? 'error' : 'ok', ...activity });

    if (!activity.error) {
      result.totals.commitCount    += activity.summary.commitCount;
      result.totals.mergedPRCount  += activity.summary.mergedPRCount;
      result.totals.closedIssueCount += activity.summary.closedIssueCount;
      activity.summary.contributors.forEach(c => result.totals.contributors.add(c));
      result.allMergedPRs.push(...activity.mergedPRs);
      result.allClosedIssues.push(...activity.closedIssues);
    }
  }

  return result;
}

// 収集データを projects_block 用 Markdown 断片に整形
function formatProjectBlock(collected, periodStart, periodEnd) {
  const p = collected.project;
  const lines = [`### ${p.project_code}: ${p.project_name}`, ''];

  lines.push('#### マスタ情報');
  lines.push(`- 顧客: ${p.client || '(未設定)'}`);
  lines.push(`- ステータス: ${p.status}`);
  lines.push('');

  lines.push(`#### GitHub アクティビティ (${periodStart} 〜 ${periodEnd})`);

  if (collected.repoActivities.length === 1 && collected.repoActivities[0].status === 'no_repos') {
    lines.push('[スキップ] リポジトリが設定されていません');
  } else {
    for (const ra of collected.repoActivities) {
      if (ra.status === 'skipped') {
        lines.push(`\n**${ra.repo}** [スキップ] --skip-github`);
        continue;
      }
      if (ra.status === 'error') {
        lines.push(`\n**${ra.repo}** [エラー] ${ra.error}`);
        continue;
      }
      const trunc = ra.truncated ? ' (100件上限到達、以降は省略)' : '';
      lines.push(`\n**${ra.repo}** [OK]`);
      lines.push(`- コミット: ${ra.summary.commitCount} 件${trunc}`);
      lines.push(`- マージ済み PR: ${ra.summary.mergedPRCount} 件`);
      lines.push(`- クローズ済み Issue: ${ra.summary.closedIssueCount} 件`);
      lines.push(`- コントリビュータ: ${ra.summary.contributors.join(', ') || 'なし'}`);
      if (ra.mergedPRs.length > 0) {
        lines.push('');
        lines.push(listTitles(ra.mergedPRs, '主な PR'));
      }
      if (ra.closedIssues.length > 0) {
        lines.push('');
        lines.push(listTitles(ra.closedIssues, '主な Issue'));
      }
    }
  }

  // 集計合計
  const t = collected.totals;
  const hasActivity = t.commitCount > 0 || t.mergedPRCount > 0 || t.closedIssueCount > 0;
  lines.push('');
  lines.push('#### 期間合計');
  if (hasActivity) {
    lines.push(`- コミット: ${t.commitCount} 件`);
    lines.push(`- マージ済み PR: ${t.mergedPRCount} 件`);
    lines.push(`- クローズ済み Issue: ${t.closedIssueCount} 件`);
    lines.push(`- コントリビュータ: ${[...t.contributors].join(', ') || 'なし'}`);
  } else {
    lines.push('期間内の活動なし(または GitHub データ未取得)');
  }

  return lines.join('\n');
}

// ロードマップの未着手・進行中マイルストーンのみ列挙
function formatRoadmapBlock(milestones) {
  if (!milestones || milestones.length === 0) return '(ロードマップ情報なし)';
  const active = milestones.filter(m => m.status === '未着手' || m.status === '進行中');
  if (active.length === 0) return '(未着手・進行中のマイルストーンなし)';
  return active
    .map(m => `- ${m.id}: ${m.name} (期限: ${m.deadline || '未設定'}, ${m.status})${m.blockers && m.blockers !== 'なし' ? `\n  ブロッカー: ${m.blockers}` : ''}`)
    .join('\n');
}

// ── Sanity check ───────────────────────────────────────────────────────────

function sanityCheck(claudeOutput, projects) {
  const warnings = [];
  const masterCodes = new Set(projects.map(p => p.project_code));

  // 案件別サマリの案件コード集合チェック
  const summarySection = claudeOutput.split('## 案件別サマリ')[1]
    ?.split('## 残課題')[0] ?? '';
  const outputCodes = new Set(
    [...summarySection.matchAll(/^### ([A-Z][A-Z0-9-]+): /gm)].map(m => m[1])
  );
  for (const code of masterCodes) {
    if (!outputCodes.has(code)) warnings.push(`案件別サマリに "${code}" が含まれていません`);
  }
  for (const code of outputCodes) {
    if (!masterCodes.has(code)) warnings.push(`案件別サマリに不明な案件コード "${code}" が含まれています`);
  }

  // 数値サマリテーブルの行数チェック
  const tableSection = claudeOutput.split('## 数値サマリ')[1]?.split(/\n## /)[0] ?? '';
  const dataRows = tableSection.split('\n')
    .filter(l => l.trim().startsWith('|') && !/^[\s|:-]+$/.test(l.trim()) && !l.includes('案件コード'));
  if (dataRows.length !== projects.length) {
    warnings.push(`数値サマリの行数が不一致: マスタ ${projects.length} 件 / 出力 ${dataRows.length} 行`);
  }

  return warnings;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: npm run weekly-report\n' +
    '       [--projects <path>] [--roadmap <path>]\n' +
    '       [--since YYYY-MM-DD] [--until YYYY-MM-DD]\n' +
    '       [--out <path>] [--skip-github] [--notion]'
  );
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      projects:       { type: 'string' },
      roadmap:        { type: 'string' },
      since:          { type: 'string' },
      until:          { type: 'string' },
      out:            { type: 'string' },
      'skip-github':  { type: 'boolean', default: false },
      notion:         { type: 'boolean', default: false },
    },
    strict: true,
  });
} catch (e) {
  console.error(`Error: ${e.message}`);
  printUsage();
  process.exit(1);
}

const { values: args } = parsed;

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  // ── Resolve dates ─────────────────────────────────────────────────────────

  const nowDate   = new Date();
  const untilDate = args.until ?? nowDate.toISOString().split('T')[0];
  const sinceDate = args.since ?? new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  let sinceIso, untilIso;
  try {
    sinceIso = parseDateToIso(sinceDate, false);
    untilIso = parseDateToIso(untilDate, true);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  if (sinceIso > untilIso) {
    console.error(`Error: --since (${sinceDate}) が --until (${untilDate}) より後になっています。`);
    process.exit(1);
  }

  console.log(`\n集計期間: ${sinceDate} 〜 ${untilDate}`);

  // ── Load projects master ──────────────────────────────────────────────────

  const projectsPath = args.projects ? resolve(process.cwd(), args.projects) : PROJECTS_DEFAULT;
  if (!existsSync(projectsPath)) {
    console.error(`Error: 案件マスタが見つかりません: ${projectsPath}`);
    process.exit(1);
  }

  let projects;
  try {
    ({ projects } = parseProjects(readFileSync(projectsPath, 'utf-8')));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  console.log(`案件マスタを読み込みました: ${projects.length} 件`);

  // ── Load roadmap (optional) ───────────────────────────────────────────────

  const roadmapPath = args.roadmap ? resolve(process.cwd(), args.roadmap) : ROADMAP_DEFAULT;
  let allMilestones = null;
  if (existsSync(roadmapPath)) {
    try {
      const { milestones } = parseRoadmap(readFileSync(roadmapPath, 'utf-8'));
      allMilestones = milestones;
      console.log(`ロードマップを読み込みました: ${milestones.length} マイルストーン`);
    } catch (err) {
      console.warn(`Warning: ロードマップの読み込みに失敗しました: ${err.message}`);
    }
  } else {
    console.warn(`Warning: ロードマップが見つかりません: ${roadmapPath} (スキップ)`);
  }

  // ── Collect activity per project ──────────────────────────────────────────

  console.log(`\nGitHub アクティビティを集計しています (${sinceDate} 〜 ${untilDate}) ...`);

  const diag = {
    github: { ok: 0, fail: 0, skip: 0 },
    failedItems: [],
    totals: { commits: 0, mergedPRs: 0, closedIssues: 0 },
  };

  const allCollected = [];
  for (const project of projects) {
    process.stdout.write(`  ${project.project_code} ... `);
    const collected = await collectProjectActivity(project, {
      since: sinceIso, until: untilIso, skipGithub: args['skip-github'],
    });
    allCollected.push(collected);

    for (const ra of collected.repoActivities) {
      if (ra.status === 'skipped' || ra.status === 'no_repos') {
        diag.github.skip++;
      } else if (ra.status === 'error') {
        diag.github.fail++;
        diag.failedItems.push(`GitHub/${ra.repo}: ${ra.error}`);
      } else {
        diag.github.ok++;
        diag.totals.commits    += ra.summary.commitCount;
        diag.totals.mergedPRs  += ra.summary.mergedPRCount;
        diag.totals.closedIssues += ra.summary.closedIssueCount;
      }
    }

    console.log('完了');
  }

  // ── Build prompt ──────────────────────────────────────────────────────────

  const projectsBlock = allCollected
    .map(c => formatProjectBlock(c, sinceDate, untilDate))
    .join('\n\n---\n\n');

  const roadmapBlock = formatRoadmapBlock(allMilestones);

  const template  = readFileSync(TEMPLATE_PATH, 'utf-8');
  const userPrompt = fillTemplate(template, {
    period_start:   sinceDate,
    period_end:     untilDate,
    projects_block: projectsBlock,
    roadmap_block:  roadmapBlock,
  });

  // ── Claude API ────────────────────────────────────────────────────────────

  console.log('\n週次レポートを生成しています ...');
  process.stdout.write('Claude API に問い合わせ中 ... ');

  let claudeOutput;
  try {
    claudeOutput = await runPrompt({
      system:
        'あなたはプロジェクト管理の専門家です。' +
        '与えられた案件アクティビティデータを分析し、指示どおりの Markdown 週次レポートを生成してください。',
      user: userPrompt,
      maxTokens: 6144,
    });
  } catch (err) {
    console.error(`\nError: Claude API エラー: ${err.message}`);
    process.exit(1);
  }

  if (!claudeOutput || claudeOutput.trim().length === 0) {
    console.error('\nError: Claude API からの応答が空でした。時間を置いて再実行してください。');
    process.exit(1);
  }

  console.log('完了\n');

  // ── Sanity check ──────────────────────────────────────────────────────────

  const warnings = sanityCheck(claudeOutput, projects);
  if (warnings.length > 0) {
    console.warn('Warning: 出力の健全性チェックで差異が検出されました:');
    warnings.forEach(w => console.warn(`  ⚠  ${w}`));
  } else {
    console.log(`健全性チェック: OK (案件コード ${projects.length} 件一致、数値サマリ行数一致)`);
  }

  // ── Append diagnostics ────────────────────────────────────────────────────

  const repoCount = projects.reduce((n, p) => n + p.repos.length, 0);
  const diagLines = [
    '\n\n---\n\n## データ取得診断',
    '',
    `- 集計期間: ${sinceDate} 〜 ${untilDate}`,
    `- 対象案件: ${projects.length} 件 / 対象リポジトリ: ${repoCount} 件`,
    `- GitHub リポジトリ: 成功 ${diag.github.ok} 件 / 失敗 ${diag.github.fail} 件 / スキップ ${diag.github.skip} 件`,
    `- 失敗リスト: ${diag.failedItems.length > 0 ? diag.failedItems.join(', ') : 'なし'}`,
    `- 全体合計: コミット ${diag.totals.commits} / マージ済み PR ${diag.totals.mergedPRs} / クローズ済み Issue ${diag.totals.closedIssues}`,
    `- 生成日時: ${new Date().toISOString()}`,
  ];
  const finalOutput = claudeOutput + diagLines.join('\n');

  // ── Save ──────────────────────────────────────────────────────────────────

  const outPath = args.out
    ? resolve(process.cwd(), args.out)
    : resolveOutPath(OUTPUTS_DIR, untilDate);
  mkdirSync(resolve(outPath, '..'), { recursive: true });
  writeFileSync(outPath, finalOutput, 'utf-8');
  console.log(`保存先: ${outPath}`);

  // ── Notion push ───────────────────────────────────────────────────────────

  if (args.notion) {
    const dbId = process.env.NOTION_DB_WEEKLY_ID;
    if (!notion.isEnabled() || !dbId) {
      console.log('Notion: スキップ (NOTION_TOKEN または NOTION_DB_WEEKLY_ID が未設定)');
    } else {
      process.stdout.write('Notion に push 中 ... ');
      const blocks = notion.markdownToBlocks(finalOutput);
      const pageResult = await notion.createPage({
        databaseId: dbId,
        properties: {
          Name:         { title: [{ text: { content: `Weekly ${sinceDate}_${untilDate}` } }] },
          PeriodStart:  { date: { start: sinceDate } },
          PeriodEnd:    { date: { start: untilDate } },
          ProjectCount: { number: projects.length },
          Status:       { select: { name: 'Draft' } },
        },
        children: blocks.slice(0, 100),
      });
      if (pageResult.ok) {
        console.log('完了');
        if (pageResult.page.url) console.log(`Notion ページ: ${pageResult.page.url}`);
        if (blocks.length > 100) {
          for (let i = 100; i < blocks.length; i += 100) {
            await notion.appendBlocks(pageResult.page.id, blocks.slice(i, i + 100));
          }
        }
      } else {
        console.log('失敗 (Markdown 出力は成功)');
      }
    }
  } else {
    console.log('Notion: スキップ (--notion フラグなし)');
  }
})().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
