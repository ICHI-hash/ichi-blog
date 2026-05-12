'use strict';

const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { resolve, basename }  = require('node:path');
const { parseArgs } = require('node:util');
const { runPrompt } = require('../lib/claude.js');
const { parseRoadmap, formatMilestone } = require('../lib/roadmap-parser.js');
const notion = require('../lib/notion.js');

const OUTPUTS_DIR    = resolve(__dirname, '../outputs/roadmap');
const INPUT_DEFAULT  = resolve(__dirname, '../inputs/roadmap.md');
const TEMPLATE_PATH  = resolve(__dirname, '../templates/roadmap.prompt.md');

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

// 同日 2 回目以降は連番を付ける
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

// マスタ全体を再構築して `## ロードマップ(マスタ反映)` セクション文字列を返す
function buildMasterSection(milestones) {
  const header = '## ロードマップ(マスタ反映)\n\n';
  const body   = milestones.map(formatMilestone).join('\n\n');
  return header + body;
}

// Claude 出力に `## ロードマップ(マスタ反映)` を挿入する
function insertMasterSection(claudeOutput, masterSection) {
  const marker = '\n## マイルストーン別評価';
  const idx = claudeOutput.indexOf(marker);
  if (idx !== -1) {
    return (
      claudeOutput.slice(0, idx) +
      '\n\n' + masterSection + '\n' +
      claudeOutput.slice(idx)
    );
  }
  // フォールバック: 末尾に追記
  return claudeOutput + '\n\n' + masterSection;
}

// ── Sanity check ───────────────────────────────────────────────────────────

function sanityCheck(claudeOutput, masterMilestones) {
  const warnings = [];
  const masterIds = new Set(masterMilestones.map(m => m.id));

  // `## マイルストーン別評価` 配下の M-ID を抽出
  const evalSection = claudeOutput.split('## マイルストーン別評価')[1]
    ?.split('## 次に着手すべきマイルストーン')[0] ?? '';
  const evalIds = new Set(
    [...evalSection.matchAll(/^### (M-\d{3,}):/gm)].map(m => m[1])
  );

  for (const id of masterIds) {
    if (!evalIds.has(id)) warnings.push(`マイルストーン別評価に "${id}" が含まれていません`);
  }
  for (const id of evalIds) {
    if (!masterIds.has(id)) warnings.push(`評価に不明な M-ID "${id}" が含まれています`);
  }

  // `## 次に着手すべきマイルストーン` 内の M-ID がマスタに存在するか
  const recSection = claudeOutput.split('## 次に着手すべきマイルストーン')[1]
    ?.split('## 全体所感')[0] ?? '';
  const recIds = [...recSection.matchAll(/M-\d{3,}/g)].map(m => m[0]);
  for (const id of recIds) {
    if (!masterIds.has(id)) {
      warnings.push(`推奨マイルストーン "${id}" がマスタに存在しません`);
    }
  }

  return warnings;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: npm run roadmap\n' +
    '       [--input <path>] [--out <path>] [--notion]'
  );
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      input:  { type: 'string' },
      out:    { type: 'string' },
      notion: { type: 'boolean', default: false },
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
  const inputPath = args.input ? resolve(process.cwd(), args.input) : INPUT_DEFAULT;

  if (!existsSync(inputPath)) {
    console.error(`Error: 入力ファイルが見つかりません: ${inputPath}`);
    console.error(`       デフォルトパス: ${INPUT_DEFAULT}`);
    console.error('       --input で明示するか、planning/inputs/roadmap.md を作成してください。');
    process.exit(1);
  }

  // ── Parse roadmap ────────────────────────────────────────────────────────

  const raw = readFileSync(inputPath, 'utf-8');
  let frontmatter, milestones;
  try {
    ({ frontmatter, milestones } = parseRoadmap(raw));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.log(`\nロードマップを読み込みました: ${milestones.length} マイルストーン`);
  milestones.forEach(m =>
    console.log(`  ${m.id}: ${m.name} [${m.status}] 期限: ${m.deadline || '未設定'}`)
  );

  // ── Build prompt ─────────────────────────────────────────────────────────

  const milestonesBlock = milestones.map(formatMilestone).join('\n\n');
  const template  = readFileSync(TEMPLATE_PATH, 'utf-8');
  const userPrompt = fillTemplate(template, {
    today:            today(),
    milestones_block: milestonesBlock,
  });

  // ── Claude API ───────────────────────────────────────────────────────────

  console.log('\nロードマップ評価を生成しています ...');
  process.stdout.write('Claude API に問い合わせ中 ... ');

  let claudeOutput;
  try {
    claudeOutput = await runPrompt({
      system:
        'あなたはプロジェクトマネジメントの専門家です。' +
        '与えられたロードマップ情報を分析し、指示どおりの Markdown を生成してください。',
      user: userPrompt,
      maxTokens: 4096,
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

  const warnings = sanityCheck(claudeOutput, milestones);
  if (warnings.length > 0) {
    console.warn('Warning: 出力の健全性チェックで差異が検出されました(人が確認してください):');
    warnings.forEach(w => console.warn(`  ⚠  ${w}`));
  } else {
    console.log(`健全性チェック: OK (M-ID ${milestones.length} 件、集合一致)`);
  }

  // ── Build final output ───────────────────────────────────────────────────

  const masterSection = buildMasterSection(milestones);
  const finalOutput   = insertMasterSection(claudeOutput, masterSection);

  // ── Save ─────────────────────────────────────────────────────────────────

  const outPath = args.out
    ? resolve(process.cwd(), args.out)
    : resolveOutPath(OUTPUTS_DIR);

  mkdirSync(resolve(outPath, '..'), { recursive: true });
  writeFileSync(outPath, finalOutput, 'utf-8');
  console.log(`保存先: ${outPath}`);

  // ── Notion push ──────────────────────────────────────────────────────────

  if (args.notion) {
    const dbId = process.env.NOTION_DB_ROADMAP_ID;
    if (!notion.isEnabled() || !dbId) {
      console.log('Notion: スキップ (NOTION_TOKEN または NOTION_DB_ROADMAP_ID が未設定)');
    } else {
      process.stdout.write('Notion に push 中 ... ');
      const blocks = notion.markdownToBlocks(finalOutput);
      const pageResult = await notion.createPage({
        databaseId: dbId,
        properties: {
          Name:           { title: [{ text: { content: `Roadmap Evaluation ${today()}` } }] },
          EvaluatedAt:    { date: { start: today() } },
          MilestoneCount: { number: milestones.length },
          Status:         { select: { name: 'Draft' } },
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
