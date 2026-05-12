'use strict';

const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { resolve, basename } = require('node:path');
const { parseArgs } = require('node:util');
const { runPrompt }         = require('../lib/claude.js');
const { parseProjects }     = require('../lib/projects-parser.js');
const { parseRoadmap }      = require('../lib/roadmap-parser.js');
const sheets                = require('../lib/sheets.js');
const github                = require('../lib/github.js');
const notion                = require('../lib/notion.js');

const OUTPUTS_DIR       = resolve(__dirname, '../outputs/dashboard');
const PROJECTS_DEFAULT  = resolve(__dirname, '../inputs/projects.md');
const ROADMAP_DEFAULT   = resolve(__dirname, '../inputs/roadmap.md');
const TEMPLATE_PATH     = resolve(__dirname, '../templates/dashboard.prompt.md');

// ── Utilities ──────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function todayCompact() {
  return today().replace(/-/g, '');
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

function resolveOutPath(dir) {
  mkdirSync(dir, { recursive: true });
  const base = todayCompact();
  let path = resolve(dir, `${base}.md`);
  let n = 2;
  while (existsSync(path)) {
    path = resolve(dir, `${base}-${n}.md`);
    n++;
  }
  return path;
}

// ── Data collection ────────────────────────────────────────────────────────

async function collectProjectData(project, roadmapMap, sheetsRows, { skipSheets, skipGithub }) {
  const collected = {
    project,
    sheetsRow: null, sheetsStatus: 'skipped',
    githubSnapshots: [],
    requirementsExists: false,
    milestones: [],
  };

  // Sheets
  if (!skipSheets) {
    if (sheetsRows === null) {
      collected.sheetsStatus = 'error';
    } else if (!project.sheets_id) {
      collected.sheetsStatus = 'no_key';
    } else {
      collected.sheetsRow = sheets.findRowByProjectCode(sheetsRows, project.sheets_id);
      collected.sheetsStatus = collected.sheetsRow ? 'ok' : 'not_found';
    }
  }

  // GitHub
  if (project.repos.length === 0) {
    collected.githubSnapshots = [{ repo: null, status: 'no_repos' }];
  } else {
    for (const repoStr of project.repos) {
      if (skipGithub) {
        collected.githubSnapshots.push({ repo: repoStr, status: 'skipped' });
        continue;
      }
      const parts = repoStr.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        collected.githubSnapshots.push({ repo: repoStr, status: 'error', error: '不正な形式 (owner/repo)' });
        continue;
      }
      const snapshot = await github.getRepoSnapshot(parts[0], parts[1]);
      collected.githubSnapshots.push({
        repo: repoStr,
        status: snapshot.error ? 'error' : 'ok',
        ...snapshot,
      });
    }
  }

  // Requirements file existence check
  if (project.requirements_path && project.requirements_path !== '未作成') {
    collected.requirementsExists = existsSync(resolve(process.cwd(), project.requirements_path));
  }

  // Milestones from roadmap
  for (const mid of project.roadmap_ids) {
    if (roadmapMap && roadmapMap.has(mid)) {
      collected.milestones.push(roadmapMap.get(mid));
    }
  }

  return collected;
}

// 収集データを projects_block 用 Markdown 断片に整形
function formatProjectBlock(c) {
  const p = c.project;
  const lines = [`### ${p.project_code}: ${p.project_name}`, ''];

  // マスタ情報
  lines.push('#### マスタ情報');
  lines.push(`- 顧客: ${p.client || '(未設定)'}`);
  lines.push(`- ステータス: ${p.status}`);
  lines.push(`- repos: ${p.repos.length > 0 ? p.repos.join(', ') : '(未設定)'}`);
  lines.push(`- requirements_path: ${p.requirements_path || '(未設定)'}`);
  lines.push('');

  // Sheets
  lines.push('#### 営業 Sheets');
  if (c.sheetsStatus === 'skipped') {
    lines.push('[スキップ] --skip-sheets フラグが指定されました');
  } else if (c.sheetsStatus === 'error') {
    lines.push('[エラー] Sheets データの取得に失敗しました');
  } else if (c.sheetsStatus === 'no_key') {
    lines.push('[スキップ] sheets_id が未設定のためマッチング不可');
  } else if (c.sheetsStatus === 'not_found') {
    lines.push(`[該当なし] sheets_id="${p.sheets_id}" に一致する行が見つかりませんでした`);
  } else {
    const r = c.sheetsRow;
    lines.push(`[OK] 案件名: ${r['案件名'] || '-'} / ステータス: ${r['ステータス'] || '-'} / 次回アクション: ${r['次回アクション'] || '-'} / 期日: ${r['次回アクション期日'] || '-'}`);
  }
  lines.push('');

  // GitHub
  lines.push('#### GitHub スナップショット');
  if (c.githubSnapshots.length === 1 && c.githubSnapshots[0].status === 'no_repos') {
    lines.push('[スキップ] リポジトリが設定されていません');
  } else {
    for (const s of c.githubSnapshots) {
      if (s.status === 'skipped') {
        lines.push(`[スキップ] ${s.repo} (--skip-github)`);
      } else if (s.status === 'error') {
        lines.push(`[エラー] ${s.repo}: ${s.error}`);
      } else {
        lines.push(
          `[OK] ${s.repo}: Open Issues: ${s.openIssues}, Open PRs: ${s.openPRs}, ` +
          `直近30日マージ済PR: ${s.mergedPRs30d}, 直近30日クローズIssue: ${s.closedIssues30d}, ` +
          `最終コミット: ${s.lastCommitAt ?? '不明'}, ブランチ: ${s.defaultBranch ?? '不明'}`
        );
      }
    }
  }
  lines.push('');

  // Requirements
  lines.push('#### 要件定義');
  if (!p.requirements_path || p.requirements_path === '未作成') {
    lines.push('[未作成] requirements_path が未設定です');
  } else {
    lines.push(c.requirementsExists
      ? `[OK] ファイル存在確認: ${p.requirements_path}`
      : `[なし] ファイルが見つかりません: ${p.requirements_path}`);
  }
  lines.push('');

  // Milestones
  lines.push('#### 関連マイルストーン(ロードマップ)');
  if (c.milestones.length === 0) {
    lines.push('(ロードマップ連携なし、または該当マイルストーンなし)');
  } else {
    for (const m of c.milestones) {
      lines.push(`- ${m.id}: ${m.name} [${m.status}] 期限: ${m.deadline || '未設定'}`);
      if (m.blockers && m.blockers !== 'なし') lines.push(`  ブロッカー: ${m.blockers}`);
    }
  }

  return lines.join('\n');
}

// ── Sanity check ───────────────────────────────────────────────────────────

function sanityCheck(claudeOutput, projects) {
  const warnings = [];
  const masterCodes = new Set(projects.map(p => p.project_code));

  const dashSection = claudeOutput.split('## 案件別ダッシュボード')[1]
    ?.split('## 横断的な気づき')[0] ?? '';

  const outputCodes = new Set(
    [...dashSection.matchAll(/^### ([A-Z][A-Z0-9-]+): /gm)].map(m => m[1])
  );

  for (const code of masterCodes) {
    if (!outputCodes.has(code)) warnings.push(`案件 "${code}" が案件別ダッシュボードに含まれていません`);
  }
  for (const code of outputCodes) {
    if (!masterCodes.has(code)) warnings.push(`不明な案件コード "${code}" が出力に含まれています`);
  }

  // 各案件セクションに必須 3 項目が含まれるか
  const required = ['進捗率', 'ブロッカー', '次のマイルストーン'];
  for (const code of masterCodes) {
    const re = new RegExp(`### ${code}: .+?(?=\\n### [A-Z]|\\n## |$)`, 's');
    const match = dashSection.match(re);
    if (match) {
      for (const field of required) {
        if (!match[0].includes(field)) {
          warnings.push(`案件 "${code}" のセクションに "${field}" が含まれていません`);
        }
      }
    }
  }

  return warnings;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: npm run dashboard\n' +
    '       [--projects <path>] [--roadmap <path>] [--out <path>]\n' +
    '       [--skip-sheets] [--skip-github] [--notion]'
  );
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      projects:       { type: 'string' },
      roadmap:        { type: 'string' },
      out:            { type: 'string' },
      'skip-sheets':  { type: 'boolean', default: false },
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
  // ── Load projects master ─────────────────────────────────────────────────

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
  console.log(`\n案件マスタを読み込みました: ${projects.length} 件`);
  projects.forEach(p => console.log(`  ${p.project_code}: ${p.project_name} [${p.status}]`));

  // ── Load roadmap (optional) ──────────────────────────────────────────────

  const roadmapPath = args.roadmap ? resolve(process.cwd(), args.roadmap) : ROADMAP_DEFAULT;
  let roadmapMap = null;
  if (existsSync(roadmapPath)) {
    try {
      const { milestones } = parseRoadmap(readFileSync(roadmapPath, 'utf-8'));
      roadmapMap = new Map(milestones.map(m => [m.id, m]));
      console.log(`ロードマップを読み込みました: ${milestones.length} マイルストーン`);
    } catch (err) {
      console.warn(`Warning: ロードマップの読み込みに失敗しました: ${err.message}`);
    }
  } else {
    console.warn(`Warning: ロードマップが見つかりません: ${roadmapPath} (スキップ)`);
  }

  // ── Load Sheets rows (optional) ──────────────────────────────────────────

  let sheetsRows = null;
  const diag = { sheets: { ok: 0, fail: 0, skip: 0 }, github: { ok: 0, fail: 0, skip: 0 }, failedItems: [] };

  if (args['skip-sheets']) {
    console.log('Sheets: スキップ (--skip-sheets)');
    diag.sheets.skip = projects.length;
  } else if (!sheets.isEnabled()) {
    console.warn('Warning: Sheets 認証情報が未設定 (PIPELINE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON)。Sheets データをスキップします。');
    diag.sheets.skip = projects.length;
    args['skip-sheets'] = true;
  } else {
    process.stdout.write('営業 Sheets を読み込み中 ... ');
    try {
      sheetsRows = await sheets.getPipelineRows();
      console.log(`完了 (${sheetsRows.length} 行)`);
    } catch (err) {
      console.warn(`\nWarning: Sheets 取得失敗: ${err.message}`);
      diag.failedItems.push(`Sheets: ${err.message}`);
      args['skip-sheets'] = true;
    }
  }

  // ── Collect data per project ──────────────────────────────────────────────

  console.log('\n案件データを収集しています ...');
  const collected = [];
  for (const project of projects) {
    process.stdout.write(`  ${project.project_code} ... `);
    const data = await collectProjectData(project, roadmapMap, sheetsRows, {
      skipSheets: args['skip-sheets'],
      skipGithub: args['skip-github'],
    });
    collected.push(data);

    // Diagnostics
    if (args['skip-sheets']) {
      diag.sheets.skip++;
    } else if (data.sheetsStatus === 'ok') {
      diag.sheets.ok++;
    } else if (data.sheetsStatus === 'error') {
      diag.sheets.fail++;
      diag.failedItems.push(`Sheets/${project.project_code}`);
    } else {
      diag.sheets.ok++;
    }

    for (const s of data.githubSnapshots) {
      if (s.status === 'skipped' || s.status === 'no_repos') {
        diag.github.skip++;
      } else if (s.status === 'error') {
        diag.github.fail++;
        diag.failedItems.push(`GitHub/${s.repo}: ${s.error}`);
      } else {
        diag.github.ok++;
      }
    }

    console.log('完了');
  }

  // ── Build prompt ─────────────────────────────────────────────────────────

  const projectsBlock = collected.map(formatProjectBlock).join('\n\n---\n\n');
  const template  = readFileSync(TEMPLATE_PATH, 'utf-8');
  const userPrompt = fillTemplate(template, {
    today:          today(),
    projects_block: projectsBlock,
  });

  // ── Claude API ───────────────────────────────────────────────────────────

  console.log('\nダッシュボードを生成しています ...');
  process.stdout.write('Claude API に問い合わせ中 ... ');

  let claudeOutput;
  try {
    claudeOutput = await runPrompt({
      system:
        'あなたはプロジェクト管理の専門家です。' +
        '与えられた案件データを分析し、指示どおりの Markdown ダッシュボードを生成してください。',
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

  // ── Sanity check ─────────────────────────────────────────────────────────

  const warnings = sanityCheck(claudeOutput, projects);
  if (warnings.length > 0) {
    console.warn('Warning: 出力の健全性チェックで差異が検出されました:');
    warnings.forEach(w => console.warn(`  ⚠  ${w}`));
  } else {
    console.log(`健全性チェック: OK (案件コード ${projects.length} 件、集合一致)`);
  }

  // ── Append diagnostics (script writes, not Claude) ───────────────────────

  const diagLines = [
    '\n\n---\n\n## データ取得診断',
    '',
    `- 生成日時: ${new Date().toISOString()}`,
    `- 対象案件: ${projects.length} 件`,
    `- 営業 Sheets: 成功 ${diag.sheets.ok} 件 / 失敗 ${diag.sheets.fail} 件 / スキップ ${diag.sheets.skip} 件`,
    `- GitHub リポジトリ: 成功 ${diag.github.ok} 件 / 失敗 ${diag.github.fail} 件 / スキップ ${diag.github.skip} 件`,
    `- 失敗・スキップ項目: ${diag.failedItems.length > 0 ? diag.failedItems.join(', ') : 'なし'}`,
  ];
  const finalOutput = claudeOutput + diagLines.join('\n');

  // ── Save ─────────────────────────────────────────────────────────────────

  const outPath = args.out ? resolve(process.cwd(), args.out) : resolveOutPath(OUTPUTS_DIR);
  mkdirSync(resolve(outPath, '..'), { recursive: true });
  writeFileSync(outPath, finalOutput, 'utf-8');
  console.log(`保存先: ${outPath}`);

  // ── Notion push ──────────────────────────────────────────────────────────

  if (args.notion) {
    const dbId = process.env.NOTION_DB_PROJECTS_ID;
    if (!notion.isEnabled() || !dbId) {
      console.log('Notion: スキップ (NOTION_TOKEN または NOTION_DB_PROJECTS_ID が未設定)');
    } else {
      process.stdout.write('Notion に push 中 ... ');
      const blocks = notion.markdownToBlocks(finalOutput);
      const pageResult = await notion.createPage({
        databaseId: dbId,
        properties: {
          Name:         { title: [{ text: { content: `Dashboard ${today()}` } }] },
          GeneratedAt:  { date: { start: today() } },
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
