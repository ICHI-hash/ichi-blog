'use strict';

const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { resolve, basename } = require('node:path');
const { parseArgs } = require('node:util');
const matter = require('gray-matter');
const { completeWithWebSearch } = require('../lib/claude.js');
const notion = require('../lib/notion.js');

const OUTPUTS_DIR   = resolve(__dirname, '../outputs/research');
const TEMPLATE_PATH = resolve(__dirname, '../templates/research.prompt.md');

// ── Utilities ──────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

// citations を Markdown セクションに整形
function formatCitationsSection(citations) {
  if (citations.length === 0) return '';
  const lines = citations.map((c, i) => {
    const idx = i + 1;
    const title = c.title || '(タイトルなし)';
    const cited = c.cited_text ? `\n    > ${c.cited_text.slice(0, 120)}` : '';
    return `[${idx}] ${title} — ${c.url}${cited}`;
  });
  return (
    '\n\n---\n\n## 出典一覧(Web 検索 API 引用情報)\n\n' +
    '> 以下は Anthropic Web 検索ツールが API レスポンスで返した引用情報です。\n' +
    '> Claude 生成テキスト内の [N] 番号と対応しない場合があります(ファクトチェック用)。\n\n' +
    lines.join('\n\n')
  );
}

// 出力 Markdown の健全性チェック
function sanityCheck(md, citations) {
  const warnings = [];

  if (!md.includes('## 出典一覧')) {
    warnings.push('出典一覧セクションが見つかりません');
  }

  const competitorIdx = md.indexOf('## 競合一覧');
  if (competitorIdx === -1) {
    warnings.push('競合一覧セクションが見つかりません');
  } else {
    const section = md.slice(competitorIdx);
    const nextH2 = section.slice(4).indexOf('\n## ');
    const tableArea = nextH2 === -1 ? section : section.slice(0, nextH2 + 4);
    const dataRows = tableArea
      .split('\n')
      .filter(l => l.trim().startsWith('|') && !/^[\s|:=-]+$/.test(l.trim()))
      .filter(l => !l.includes('企業名') && !l.includes('カテゴリ'));
    if (dataRows.length === 0) {
      warnings.push('競合一覧テーブルにデータ行がありません');
    }
  }

  if (citations.length === 0) {
    warnings.push(
      'API citations が 0 件です。Web 検索ツールが機能していない可能性があります。' +
      ' (NOTION_TOKEN 未設定・検索が発動しなかった等)'
    );
  }

  return warnings;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: npm run research -- --input <path>\n' +
    '       [--max-uses <n>] [--out <path>] [--notion]'
  );
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      input:      { type: 'string' },
      'max-uses': { type: 'string' },
      out:        { type: 'string' },
      notion:     { type: 'boolean', default: false },
    },
    strict: true,
  });
} catch (e) {
  console.error(`Error: ${e.message}`);
  printUsage();
  process.exit(1);
}

const { values: args } = parsed;

if (!args.input) {
  console.error('Error: --input は必須です。');
  printUsage();
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  const inputPath = resolve(process.cwd(), args.input);

  if (!existsSync(inputPath)) {
    console.error(`Error: 入力ファイルが見つかりません: ${inputPath}`);
    process.exit(1);
  }

  // ── Parse input ──────────────────────────────────────────────────────────

  const raw = readFileSync(inputPath, 'utf-8');
  const { data: fm, content: body } = matter(raw);

  const title         = fm.title         ?? basename(inputPath, '.md');
  const targetMarket  = fm.target_market ?? '';
  const maxCompetitors = String(fm.max_competitors ?? 8);
  const maxSearchesFm  = String(fm.max_searches ?? 5);
  const maxUses        = parseInt(args['max-uses'] ?? maxSearchesFm, 10) || 5;

  // ── Output path ──────────────────────────────────────────────────────────

  const outPath = args.out
    ? resolve(process.cwd(), args.out)
    : resolve(OUTPUTS_DIR, `${basename(inputPath, '.md')}.md`);

  // ── Build prompt ─────────────────────────────────────────────────────────

  const template  = readFileSync(TEMPLATE_PATH, 'utf-8');
  const userPrompt = fillTemplate(template, {
    title,
    body:            body.trim(),
    target_market:   targetMarket,
    max_competitors: maxCompetitors,
    max_searches:    maxUses.toString(),
    today:           today(),
  });

  // ── Web 検索付き Claude API ──────────────────────────────────────────────

  console.log(`\n競合・市場リサーチを開始しています: ${title}`);
  console.log(`Web 検索上限: ${maxUses} 回 (課金対象: $10/1,000 searches)`);
  process.stdout.write('Claude API (web_search_20250305) に問い合わせ中 ... ');

  let text, citations, usage;
  try {
    ({ text, citations, usage } = await completeWithWebSearch(userPrompt, {
      system:
        'あなたは IT 市場調査の専門アナリストです。' +
        'Web 検索を活用して最新情報を収集し、指示どおりの Markdown レポートを生成してください。',
      maxUses,
      maxTokens: 8192,
    }));
  } catch (err) {
    const msg = err.message ?? String(err);
    const extra = msg.toLowerCase().includes('web_search') || msg.includes('429') || msg.includes('search')
      ? '\n  ⚠ Web 検索ツールは課金対象です。Anthropic Console で利用状況を確認してください。'
      : '';
    console.error(`\nError: Claude API エラー: ${msg}${extra}`);
    process.exit(1);
  }

  const searchCount = usage?.server_tool_use?.web_search_requests ?? '不明';
  console.log(`完了 (検索 ${searchCount} 回)\n`);

  // ── Append API citations ─────────────────────────────────────────────────

  const fullOutput = text + formatCitationsSection(citations);

  // ── Sanity check ─────────────────────────────────────────────────────────

  const warnings = sanityCheck(fullOutput, citations);
  if (warnings.length > 0) {
    console.warn('Warning: 出力の健全性チェックで差異が検出されました:');
    warnings.forEach(w => console.warn(`  ⚠  ${w}`));
  } else {
    console.log(`健全性チェック: OK (citations ${citations.length} 件)`);
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  mkdirSync(resolve(outPath, '..'), { recursive: true });
  writeFileSync(outPath, fullOutput, 'utf-8');
  console.log(`\n保存先: ${outPath}`);
  console.log(`API citations: ${citations.length} 件 / Web 検索: ${searchCount} 回`);

  // ── Notion push ──────────────────────────────────────────────────────────

  if (args.notion) {
    const dbId = process.env.NOTION_DB_RESEARCH_ID;
    if (!notion.isEnabled() || !dbId) {
      console.log('Notion: スキップ (NOTION_TOKEN または NOTION_DB_RESEARCH_ID が未設定)');
    } else {
      process.stdout.write('Notion に push 中 ... ');
      const blocks = notion.markdownToBlocks(fullOutput);
      const pageResult = await notion.createPage({
        databaseId: dbId,
        properties: {
          Name:      { title: [{ text: { content: title } }] },
          Market:    { rich_text: [{ text: { content: targetMarket } }] },
          CreatedAt: { date: { start: today() } },
          Status:    { select: { name: 'Draft' } },
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
