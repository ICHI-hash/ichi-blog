import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
// sales/lib/claude.js から見て ../../.env がリポジトリ直下の .env
config({ path: resolve(__dirname, '../../.env') });

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY が読み込めません。リポジトリ直下の .env を確認してください。');
}

const MODEL = 'claude-sonnet-4-6';
const client = new Anthropic();

export async function callClaude({ system, user, maxTokens = 4096 }) {
  const messages = [{ role: 'user', content: user }];
  const req = { model: MODEL, max_tokens: maxTokens, messages };
  if (system) req.system = system;
  const msg = await client.messages.create(req);
  return msg.content[0].text;
}

/**
 * web_search サーバーツールを使って Claude に Web 検索付きで問い合わせる。
 * 検索の実行と結果の取り込みは API 側が 1 回の呼び出し内で完結する（自前ループ不要）。
 *
 * @param {object} opts
 * @param {string} [opts.system]      - システムプロンプト（省略可）
 * @param {string}  opts.prompt       - ユーザーへのプロンプト
 * @param {number} [opts.maxSearches] - web_search の最大呼び出し回数（デフォルト 5）
 * @param {number} [opts.maxTokens]   - max_tokens（デフォルト 4000）
 * @returns {Promise<string>} レスポンスの text ブロックをすべて結合した文字列
 */
export async function askWithWebSearch({ system, prompt, maxSearches = 5, maxTokens = 4000 }) {
  const messages = [{ role: 'user', content: prompt }];
  const req = {
    model: MODEL,
    max_tokens: maxTokens,
    messages,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
  };
  if (system) req.system = system;
  const msg = await client.messages.create(req);
  return msg.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
}

export { MODEL };
