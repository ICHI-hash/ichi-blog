'use strict';
// CJS 独立実装。planning/lib/claude.js と同一パターン。
// API シグネチャ(runPrompt / getClient / MODEL)は planning と同一。

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

module.exports = { MODEL, getClient, runPrompt };
