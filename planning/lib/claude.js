'use strict';
// CJS 独立実装。engineering/lib/claude.js は "type":"module"(ESM)のため
// require() で読めず薄いラッパーにできない。同等の実装を CommonJS で提供する。
// API シグネチャ(runPrompt / getClient / MODEL)は engineering と同一。

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY が読み込めません。リポジトリ直下の .env を確認してください。');
}

const MODEL = 'claude-sonnet-4-6';

let _client;
function getClient() {
  if (!_client) {
    const pkg = require('@anthropic-ai/sdk');
    const Anthropic = pkg.default ?? pkg;
    _client = new Anthropic();
  }
  return _client;
}

async function runPrompt({ system, user, maxTokens = 4096 }) {
  const messages = [{ role: 'user', content: user }];
  const req = { model: MODEL, max_tokens: maxTokens, messages };
  if (system) req.system = system;
  const response = await getClient().messages.create(req);
  return response.content[0].text;
}

/**
 * completeWithWebSearch(user, opts) → { text, citations, usage }
 *
 * web_search_20250305 ツール付きで Messages API を呼び出す。
 * opts: { system?, maxUses=5, maxTokens=8192 }
 *
 * citations: Array<{ url, title, cited_text }>
 *   - 各 text ブロックに埋め込まれた web_search_result_location を URL で重複除去して返す
 * usage: API レスポンスの usage オブジェクト(server_tool_use.web_search_requests を含む)
 *
 * 失敗時はそのまま throw する(呼び出し側でハンドリング)。
 */
async function completeWithWebSearch(user, { system, maxUses = 5, maxTokens = 8192 } = {}) {
  const req = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: user }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
  };
  if (system) req.system = system;

  const response = await getClient().messages.create(req);

  const textParts = [];
  const citations = [];
  const seenUrls = new Set();

  for (const block of response.content) {
    if (block.type !== 'text') continue;
    textParts.push(block.text);
    if (Array.isArray(block.citations)) {
      for (const c of block.citations) {
        if (c.type === 'web_search_result_location' && c.url && !seenUrls.has(c.url)) {
          seenUrls.add(c.url);
          citations.push({ url: c.url, title: c.title ?? '', cited_text: c.cited_text ?? '' });
        }
      }
    }
  }

  return { text: textParts.join(''), citations, usage: response.usage };
}

module.exports = { MODEL, getClient, runPrompt, completeWithWebSearch };
