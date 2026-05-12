'use strict';
const fs   = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

const NOTION_TOKEN     = process.env.NOTION_TOKEN;
const X_POSTS_DB_ID    = process.env.NOTION_X_POSTS_DB_ID;
const NOTE_DB_ID       = process.env.NOTION_NOTE_DB_ID;

const DAY_NAMES = ['月曜', '火曜', '水曜', '木曜', '金曜'];

function checkEnv() {
  const missing = ['NOTION_TOKEN', 'NOTION_X_POSTS_DB_ID', 'NOTION_NOTE_DB_ID']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌ 未設定の環境変数:', missing.join(', '));
    process.exit(1);
  }
}

function findLatest(pattern) {
  const draftsDir = path.join(__dirname, '..', 'drafts');
  const files = fs.readdirSync(draftsDir)
    .filter(f => pattern.test(f))
    .sort()
    .reverse();
  if (!files.length) throw new Error(`ドラフトが見つかりません: ${pattern}`);
  return path.join(draftsDir, files[0]);
}

function parseXPosts(markdown) {
  const posts = [];
  const sections = markdown.split(/(?=^## 投稿 \d+)/m).filter(s => s.startsWith('## 投稿'));
  for (const section of sections) {
    const lines = section.split('\n');
    const typeMatch = lines[0].match(/\[(.+?)\]/);
    const type = typeMatch ? typeMatch[1] : '投稿';
    const contentLines = lines.slice(1).filter(l => l.trim() && !l.startsWith('文字数'));
    const text = contentLines.join('\n').trim();
    if (text) posts.push({ type, text });
  }
  return posts;
}

// 基準日の翌週月〜金の日付を返す（日曜生成 → 翌月〜金）
function getWeekdayDates(draftDateStr) {
  const base = new Date(draftDateStr + 'T00:00:00Z');
  const dow = base.getUTCDay();
  const daysToMonday = dow === 0 ? 1 : (8 - dow) % 7 || 7;
  const monday = new Date(base);
  monday.setUTCDate(base.getUTCDate() + daysToMonday);
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d.toISOString().split('T')[0];
  });
}

// 基準日の翌木曜日を返す
function getNextThursday(draftDateStr) {
  const base = new Date(draftDateStr + 'T00:00:00Z');
  const dow = base.getUTCDay();
  const daysToThursday = (4 - dow + 7) % 7 || 7;
  const thu = new Date(base);
  thu.setUTCDate(base.getUTCDate() + daysToThursday);
  return thu.toISOString().split('T')[0];
}

function richText(t) {
  return [{ type: 'text', text: { content: String(t).slice(0, 2000) } }];
}

function markdownToBlocks(md) {
  const blocks = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t || t === '---') continue;
    if      (t.startsWith('### ')) blocks.push({ object: 'block', type: 'heading_3',           heading_3:           { rich_text: richText(t.slice(4)) } });
    else if (t.startsWith('## '))  blocks.push({ object: 'block', type: 'heading_2',           heading_2:           { rich_text: richText(t.slice(3)) } });
    else if (t.startsWith('# '))   blocks.push({ object: 'block', type: 'heading_1',           heading_1:           { rich_text: richText(t.slice(2)) } });
    else if (/^[-*] /.test(t))     blocks.push({ object: 'block', type: 'bulleted_list_item',  bulleted_list_item:  { rich_text: richText(t.slice(2)) } });
    else if (/^\d+\. /.test(t))    blocks.push({ object: 'block', type: 'numbered_list_item',  numbered_list_item:  { rich_text: richText(t.replace(/^\d+\. /, '')) } });
    else                            blocks.push({ object: 'block', type: 'paragraph',           paragraph:           { rich_text: richText(t) } });
  }
  return blocks;
}

async function appendBlocksChunked(notion, pageId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + 100) });
  }
}

// ── X投稿 → Notion ────────────────────────────────────────────────────────
async function publishXPosts(notion, draftPath) {
  const markdown = fs.readFileSync(draftPath, 'utf-8');
  const dateStr  = path.basename(draftPath).slice(0, 10);
  const posts    = parseXPosts(markdown);
  const dates    = getWeekdayDates(dateStr);
  const theme    = markdown.match(/テーマ: (.+)/)?.[1]?.trim() || '';

  console.log(`\n🐦 X投稿 → Notion（${posts.length}本）`);

  for (let i = 0; i < Math.min(posts.length, 5); i++) {
    const { type, text } = posts[i];
    const title = `${DAY_NAMES[i]} 投稿${i + 1}【${type}】`;

    await notion.pages.create({
      parent: { database_id: X_POSTS_DB_ID },
      properties: {
        'Name':       { title:     [{ text: { content: title } }] },
        '本文':       { rich_text: richText(text) },
        '予定日':     { date:      { start: dates[i] } },
        'ステータス': { select:    { name: '下書き' } },
        'テーマ':     { rich_text: richText(theme) },
      },
    });
    console.log(`  ✅ ${title} → ${dates[i]}`);
  }
}

// ── note記事 → Notion ─────────────────────────────────────────────────────
async function publishNoteArticle(notion, draftPath) {
  const markdown    = fs.readFileSync(draftPath, 'utf-8');
  const dateStr     = path.basename(draftPath).slice(0, 10);
  const lines       = markdown.split('\n');
  const titleLine   = lines.find(l => l.startsWith('# ')) || '';
  const title       = titleLine.slice(2).trim() || path.basename(draftPath, '.md');
  const publishDate = getNextThursday(dateStr);
  const body        = lines.filter(l => !l.startsWith('# ')).join('\n');
  const blocks      = markdownToBlocks(body);

  console.log(`\n📰 note記事 → Notion`);
  console.log(`  タイトル: ${title}`);
  console.log(`  公開予定: ${publishDate} 19:00 JST`);

  const page = await notion.pages.create({
    parent: { database_id: NOTE_DB_ID },
    properties: {
      'Name':       { title:     [{ text: { content: title } }] },
      '公開予定日': { date:      { start: publishDate } },
      'ステータス': { select:    { name: '下書き' } },
    },
    children: blocks.slice(0, 100),
  });

  if (blocks.length > 100) {
    await appendBlocksChunked(notion, page.id, blocks.slice(100));
  }

  console.log(`  ✅ Notionページ作成完了（${blocks.length}ブロック）`);
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  checkEnv();
  const notion = new Client({ auth: NOTION_TOKEN });

  console.log('\n🚀 Notion出力開始');

  const xPath   = findLatest(/^\d{4}-\d{2}-\d{2}_x_posts\.md$/);
  const notePath = findLatest(/^\d{4}-\d{2}-\d{2}_note_article\.md$/);

  await publishXPosts(notion, xPath);
  await publishNoteArticle(notion, notePath);

  console.log('\n✨ Notion出力完了\n');
}

main().catch(err => {
  console.error('❌ エラー:', err.message);
  if (err.body) console.error('詳細:', JSON.stringify(err.body, null, 2));
  process.exit(1);
});
