'use strict';
// Notion 連携は各機能の --notion フラグで有効化、未設定時は no-op。
// NOTION_TOKEN が未設定の場合 getClient() は null を返し、各関数は警告のみで終了する。

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

let _client = null;

function getClient() {
  if (!process.env.NOTION_TOKEN) return null;
  if (!_client) {
    const { Client } = require('@notionhq/client');
    _client = new Client({ auth: process.env.NOTION_TOKEN });
  }
  return _client;
}

function isEnabled() {
  return Boolean(process.env.NOTION_TOKEN);
}

async function createPage({ databaseId, properties, children = [] }) {
  const client = getClient();
  if (!client) return { ok: false, error: 'NOTION_TOKEN not set' };
  try {
    const page = await client.pages.create({
      parent: { database_id: databaseId },
      properties,
      children,
    });
    return { ok: true, page };
  } catch (err) {
    console.warn('[notion] createPage failed:', err.message);
    return { ok: false, error: err };
  }
}

async function appendBlocks(pageId, children) {
  const client = getClient();
  if (!client) return { ok: false, error: 'NOTION_TOKEN not set' };
  try {
    const result = await client.blocks.children.append({ block_id: pageId, children });
    return { ok: true, result };
  } catch (err) {
    console.warn('[notion] appendBlocks failed:', err.message);
    return { ok: false, error: err };
  }
}

// ── Markdown → Notion blocks ────────────────────────────────────────────────

function _richText(text) {
  return [{ type: 'text', text: { content: String(text).slice(0, 2000) } }];
}

function _block(type, text) {
  return { object: 'block', type, [type]: { rich_text: _richText(text) } };
}

// 最小実装: 見出し・箇条書き・番号付き・引用・段落のみ対応。
// 表・コードブロック・水平線は段落として落とす。
function markdownToBlocks(md) {
  const blocks = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t || t === '---' || t === '***') continue;

    if (t.startsWith('### '))      blocks.push(_block('heading_3', t.slice(4)));
    else if (t.startsWith('## '))  blocks.push(_block('heading_2', t.slice(3)));
    else if (t.startsWith('# '))   blocks.push(_block('heading_1', t.slice(2)));
    else if (/^[-*] /.test(t))     blocks.push(_block('bulleted_list_item', t.slice(2)));
    else if (/^\d+\. /.test(t))    blocks.push(_block('numbered_list_item', t.replace(/^\d+\. /, '')));
    else if (t.startsWith('> '))   blocks.push(_block('quote', t.slice(2)));
    else                            blocks.push(_block('paragraph', t));
  }
  return blocks;
}

module.exports = { getClient, isEnabled, createPage, appendBlocks, markdownToBlocks };
