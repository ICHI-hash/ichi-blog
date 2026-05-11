import { getClient, runPrompt } from '../lib/claude.js';

// API 疎通確認: クライアントが初期化できること・レスポンスが返ること
const client = getClient();
console.log('Anthropic client initialized:', client.constructor.name);

const result = await runPrompt({
  system: 'あなたは ICHI 技術部門の AI です。',
  user: '挨拶を 1 行で返してください。',
});

console.log('Response:', result);
