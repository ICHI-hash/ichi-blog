import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
// engineering/lib/claude.js から見て ../../.env がリポジトリ直下の .env
config({ path: resolve(__dirname, '../../.env') });

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY が読み込めません。リポジトリ直下の .env を確認してください。');
}

export const MODEL = 'claude-sonnet-4-6';

let _client;
export function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

export async function runPrompt({ system, user, maxTokens = 4096 }) {
  const messages = [{ role: 'user', content: user }];
  const req = { model: MODEL, max_tokens: maxTokens, messages };
  if (system) req.system = system;
  const response = await getClient().messages.create(req);
  return response.content[0].text;
}
