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

export { MODEL };
