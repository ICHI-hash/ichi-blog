'use strict';

const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { resolve, basename } = require('node:path');
const { parseArgs } = require('node:util');
const { runPrompt } = require('../lib/claude.js');
const { parseFeatures } = require('../lib/requirements-parser.js');

const OUTPUTS_DIR   = resolve(__dirname, '../outputs/estimates');
const TEMPLATE_PATH = resolve(__dirname, '../templates/estimate.prompt.md');

// ── Utilities ──────────────────────────────────────────────────────────────

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

// 出力 Markdown の機能別見積もり表を軽量チェックし、警告リストを返す
function sanityCheck(outputMd, inputFeatures) {
  const inputIds = new Set(inputFeatures.map(f => f.id));
  const warnings = [];

  // テーブル行から F-ID を抽出: `| F-001 | ...`
  const tableIds = [];
  const rowRe = /^\|\s*(F-\d{3,})\s*\|/gm;
  let m;
  while ((m = rowRe.exec(outputMd)) !== null) {
    tableIds.push(m[1]);
  }

  if (tableIds.length !== inputFeatures.length) {
    warnings.push(
      `機能数の不一致: 入力 ${inputFeatures.length} 件 / 出力表 ${tableIds.length} 行`
    );
  }

  const outputIds = new Set(tableIds);
  for (const id of tableIds) {
    if (!inputIds.has(id)) warnings.push(`不明な F-ID が出力表に含まれています: ${id}`);
  }
  for (const id of inputIds) {
    if (!outputIds.has(id)) warnings.push(`入力の F-ID が出力表に含まれていません: ${id}`);
  }

  return warnings;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: npm run estimate -- ( --requirements <path> | --features <path> )\n' +
    '       [--out <path>] [--project-context <text>]'
  );
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      requirements:      { type: 'string' },
      features:          { type: 'string' },
      out:               { type: 'string' },
      'project-context': { type: 'string' },
    },
    strict: true,
  });
} catch (e) {
  console.error(`Error: ${e.message}`);
  printUsage();
  process.exit(1);
}

const { values: args } = parsed;

if (!args.requirements && !args.features) {
  console.error('Error: --requirements または --features のどちらかは必須です。');
  printUsage();
  process.exit(1);
}

if (args.requirements && args.features) {
  console.error('Error: --requirements と --features は同時に指定できません。');
  printUsage();
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  const inputPath = resolve(process.cwd(), args.requirements ?? args.features);

  if (!existsSync(inputPath)) {
    console.error(`Error: 入力ファイルが見つかりません: ${inputPath}`);
    process.exit(1);
  }

  // ── Parse features ───────────────────────────────────────────────────────

  const inputMd = readFileSync(inputPath, 'utf-8');
  let features;
  try {
    features = parseFeatures(inputMd);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n機能リストを読み込みました: ${features.length} 件`);
  features.forEach(f => console.log(`  ${f.id}: ${f.name}`));

  // ── Build prompt ─────────────────────────────────────────────────────────

  const featuresBlock = features
    .map(f => `### ${f.id}: ${f.name}\n${f.body}`)
    .join('\n\n');

  // タイトルは入力ファイル名または Markdown h1 行から取得
  const h1Match = inputMd.match(/^# (.+)$/m);
  const title = h1Match ? h1Match[1].trim() : basename(inputPath, '.md');

  const contextSection = args['project-context']
    ? `\n## 案件コンテキスト\n\n${args['project-context']}\n`
    : '';

  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  const userPrompt = fillTemplate(template, {
    title,
    features_block:  featuresBlock,
    project_context: contextSection,
  });

  // ── Claude API ───────────────────────────────────────────────────────────

  console.log(`\n工数見積もりを生成しています: ${title}`);
  process.stdout.write('Claude API に問い合わせ中 ... ');

  let result;
  try {
    result = await runPrompt({
      system:
        'あなたは IT プロジェクトの工数見積もりの専門家です。' +
        '指示どおりの Markdown を生成してください。',
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

  // ── Sanity check ─────────────────────────────────────────────────────────

  const warnings = sanityCheck(result, features);
  if (warnings.length > 0) {
    console.warn('Warning: 出力の健全性チェックで差異が検出されました(人が確認してください):');
    warnings.forEach(w => console.warn(`  ⚠  ${w}`));
  } else {
    console.log(`健全性チェック: OK (機能数 ${features.length} 件、F-ID 一致)`);
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  let outPath;
  if (args.out) {
    outPath = resolve(process.cwd(), args.out);
  } else {
    const inputBase = basename(inputPath, '.md');
    outPath = resolve(OUTPUTS_DIR, `${inputBase}.estimate.md`);
  }

  mkdirSync(resolve(outPath, '..'), { recursive: true });
  writeFileSync(outPath, result, 'utf-8');

  console.log(`\n機能数 ${features.length} 件を見積もりました。`);
  console.log(`保存先: ${outPath}`);
})().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
