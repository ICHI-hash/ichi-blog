import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPrompt } from '../lib/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUTS_TRIAGE_DIR = resolve(__dirname, '../outputs/triage');

// ── Utilities ──────────────────────────────────────────────────────────────

function jstTimestamp() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const p = n => String(n).padStart(2, '0');
  return (
    `${jst.getUTCFullYear()}` +
    `${p(jst.getUTCMonth() + 1)}` +
    `${p(jst.getUTCDate())}-` +
    `${p(jst.getUTCHours())}` +
    `${p(jst.getUTCMinutes())}` +
    `${p(jst.getUTCSeconds())}`
  );
}

function guessRepo() {
  try {
    const url = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const m = url.match(/github\.com[/:]([^/\s]+\/[^/\s.]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function isGhAvailable() {
  return spawnSync('gh', ['--version'], { stdio: 'pipe' }).status === 0;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: npm run triage -- --input <ログ.md> [--repo <owner/repo>] [--create-issue]'
  );
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      input:          { type: 'string' },
      repo:           { type: 'string' },
      'create-issue': { type: 'boolean', default: false },
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

// ── Input file ─────────────────────────────────────────────────────────────

const inputPath = resolve(process.cwd(), args.input);
if (!existsSync(inputPath)) {
  console.error(`Error: 入力ファイルが見つかりません: ${inputPath}`);
  process.exit(1);
}

const inputContent = readFileSync(inputPath, 'utf-8');
if (inputContent.trim().length === 0) {
  console.error('Error: 入力ファイルが空です。');
  process.exit(1);
}

// ── Claude API ─────────────────────────────────────────────────────────────

console.log(`\n障害レポートをトリアージしています: ${args.input}`);
process.stdout.write('Claude API に問い合わせ中 ... ');

const issue = await runPrompt({
  system:
    'あなたは SRE のリードエンジニアです。与えられた障害情報から、' +
    'GitHub Issue の草案を Markdown で生成してください。\n' +
    '必須セクション:\n' +
    '1. タイトル (1 行、簡潔に。最初の行に `# ` で始める形)\n' +
    '2. 概要 (3 行以内)\n' +
    '3. 原因仮説 (優先度順に箇条書きで 3 つまで、各仮説の根拠を 1 行)\n' +
    '4. 影響範囲 (ユーザ/機能/データへの影響)\n' +
    '5. 推奨初動 (今すぐやるべきこと 3 つまで)\n' +
    '6. 中長期の改善提案 (再発防止策)\n' +
    '7. 確認チェックリスト ([ ] 形式で 5 件程度)\n' +
    '出力は Markdown のみ。前置きや後置きの説明文は不要',
  user: inputContent,
  maxTokens: 4096,
});

if (!issue || issue.trim().length === 0) {
  console.error('\nError: Claude API からの応答が空でした。時間を置いて再実行してください。');
  process.exit(1);
}

console.log('完了\n');

// ── Save & print ───────────────────────────────────────────────────────────

mkdirSync(OUTPUTS_TRIAGE_DIR, { recursive: true });
const timestamp = jstTimestamp();
const outPath = resolve(OUTPUTS_TRIAGE_DIR, `${timestamp}.md`);
writeFileSync(outPath, issue, 'utf-8');

console.log('─'.repeat(64));
console.log(issue);
console.log('─'.repeat(64));
console.log(`\n保存先: ${outPath}`);

// ── Create GitHub Issue ────────────────────────────────────────────────────

if (args['create-issue']) {
  const repo = args.repo ?? guessRepo();
  if (!repo) {
    console.error(
      '\nError: --repo を指定するか、GitHub リモートが設定された git リポジトリで実行してください。' +
      '\n       例: npm run triage -- --input <md> --create-issue --repo owner/repo'
    );
    process.exit(1);
  }

  if (!isGhAvailable()) {
    console.warn(
      '\nWarning: gh コマンドが見つかりません。Issue の作成をスキップします。' +
      '\n         GitHub CLI をインストールしてください: https://cli.github.com' +
      `\n         Issue 草案は ${outPath} に保存済みです。`
    );
    process.exit(0);
  }

  const firstLine = issue.split('\n').find(l => l.startsWith('# '));
  const title = firstLine ? firstLine.replace(/^#\s+/, '') : 'Incident Report';

  const result = spawnSync(
    'gh',
    ['issue', 'create', '--repo', repo, '--title', title, '--body-file', outPath],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );

  if (result.status !== 0) {
    console.error(`\nError: Issue の作成に失敗しました。\n${result.stderr.trim()}`);
    console.error(`Issue 草案は ${outPath} に保存済みです。`);
    process.exit(1);
  }

  console.log(`\nIssue を作成しました: ${result.stdout.trim()}`);
}
