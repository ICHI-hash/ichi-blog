'use strict';

const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseArgs } = require('node:util');
const matter = require('gray-matter');
const { runPrompt } = require('../lib/claude.js');
const notion = require('../lib/notion.js');

const OUTPUTS_DIR  = resolve(__dirname, '../outputs/requirements');
const INPUTS_DIR_DEFAULT = resolve(__dirname, '../inputs/requirements');
const TEMPLATE_PATH = resolve(__dirname, '../templates/requirements.prompt.md');

// ── Utilities ──────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

// gray-matter は YAML の日付値を Date オブジェクトに変換する
function fmtDate(v) {
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return String(v);
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: npm run gen:requirements -- --project <案件コード>\n' +
    '       [--input-dir <dir>] [--example] [--force] [--notion]'
  );
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      project:     { type: 'string' },
      'input-dir': { type: 'string' },
      example:     { type: 'boolean', default: false },
      force:       { type: 'boolean', default: false },
      notion:      { type: 'boolean', default: false },
    },
    strict: true,
  });
} catch (e) {
  console.error(`Error: ${e.message}`);
  printUsage();
  process.exit(1);
}

const { values: args } = parsed;

if (!args.project) {
  console.error('Error: --project は必須です。');
  printUsage();
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  const projectCode = args.project;
  const inputDir = args['input-dir']
    ? resolve(process.cwd(), args['input-dir'])
    : INPUTS_DIR_DEFAULT;

  // ── Input files ──────────────────────────────────────────────────────────

  function findInput(base) {
    const direct = resolve(inputDir, base);
    if (existsSync(direct)) return direct;
    if (args.example) {
      const ex = resolve(inputDir, base.replace(/\.md$/, '.example.md'));
      if (existsSync(ex)) return ex;
    }
    return null;
  }

  const projectPath = findInput(`${projectCode}.project.md`);
  if (!projectPath) {
    const hint = args.example
      ? ''
      : ' (--example フラグで .example.md にフォールバックできます)';
    console.error(`Error: 案件情報ファイルが見つかりません: ${projectCode}.project.md${hint}`);
    process.exit(1);
  }

  const hearingPath = findInput(`${projectCode}.hearing.md`);
  if (!hearingPath) {
    const hint = args.example
      ? ''
      : ' (--example フラグで .example.md にフォールバックできます)';
    console.error(`Error: ヒアリングメモファイルが見つかりません: ${projectCode}.hearing.md${hint}`);
    process.exit(1);
  }

  // ── Parse frontmatter ────────────────────────────────────────────────────

  const { data: fm, content: projectBody } = matter(readFileSync(projectPath, 'utf-8'));

  const required = ['client', 'project', 'project_code', 'start_date', 'deadline'];
  for (const f of required) {
    if (!fm[f]) {
      console.error(`Error: ${projectPath} の frontmatter に "${f}" が見つかりません。`);
      process.exit(1);
    }
  }

  const hearingMd = readFileSync(hearingPath, 'utf-8');

  // ── Output path ──────────────────────────────────────────────────────────

  const outPath = resolve(OUTPUTS_DIR, `${projectCode}.md`);
  if (existsSync(outPath) && !args.force) {
    console.error(
      `Error: 出力ファイルが既に存在します: ${outPath}\n` +
      '       上書きする場合は --force を付けてください。'
    );
    process.exit(1);
  }

  // ── Build prompt ─────────────────────────────────────────────────────────

  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  const userPrompt = fillTemplate(template, {
    client:           fm.client,
    project:          fm.project,
    project_code:     fm.project_code,
    start_date:       fmtDate(fm.start_date),
    deadline:         fmtDate(fm.deadline),
    budget_range:     fm.budget_range ?? '未定',
    project_overview: projectBody.trim(),
    hearing_md:       hearingMd.trim(),
    today:            today(),
  });

  // ── Claude API ───────────────────────────────────────────────────────────

  console.log(`\n要件定義書を生成しています: ${fm.project} (${fm.client})`);
  process.stdout.write('Claude API に問い合わせ中 ... ');

  let result;
  try {
    result = await runPrompt({
      system: 'あなたは IT プロジェクトの要件定義の専門家です。指示どおりの Markdown を生成してください。',
      user: userPrompt,
      maxTokens: 8192,
    });
  } catch (err) {
    console.error(`\nError: Claude API エラー: ${err.message}`);
    process.exit(1);
  }

  if (!result || result.trim().length === 0) {
    console.error('\nError: Claude API からの応答が空でした。時間を置いて再実行してください。');
    process.exit(1);
  }

  console.log('完了\n');

  // ── Save ─────────────────────────────────────────────────────────────────

  mkdirSync(OUTPUTS_DIR, { recursive: true });
  writeFileSync(outPath, result, 'utf-8');
  console.log(`保存先: ${outPath}`);

  // ── Notion push ──────────────────────────────────────────────────────────

  if (args.notion) {
    const dbId = process.env.NOTION_DB_REQUIREMENTS_ID;
    if (!notion.isEnabled() || !dbId) {
      console.log('Notion: スキップ (NOTION_TOKEN または NOTION_DB_REQUIREMENTS_ID が未設定)');
    } else {
      process.stdout.write('Notion に push 中 ... ');
      const blocks = notion.markdownToBlocks(result);
      const pageResult = await notion.createPage({
        databaseId: dbId,
        properties: {
          Name:        { title: [{ text: { content: fm.project } }] },
          Client:      { rich_text: [{ text: { content: fm.client } }] },
          ProjectCode: { rich_text: [{ text: { content: fm.project_code } }] },
          Status:      { select: { name: 'Draft' } },
          CreatedAt:   { date: { start: today() } },
        },
        // Notion API は 1 リクエスト 100 ブロックまで
        children: blocks.slice(0, 100),
      });

      if (pageResult.ok) {
        console.log('完了');
        if (pageResult.page.url) console.log(`Notion ページ: ${pageResult.page.url}`);
        // 残りのブロックを追記
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
