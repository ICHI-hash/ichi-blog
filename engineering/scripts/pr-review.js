import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Octokit } from '@octokit/rest';
import { runPrompt, MODEL } from '../lib/claude.js';

const DIFF_MAX_CHARS = 50_000;
const REVIEW_HEADER  = `🤖 **Claude Code Review** (${MODEL})`;

const SYSTEM_PROMPT =
  'あなたはシニアソフトウェアエンジニアのコードレビュアーです。\n' +
  '与えられた PR の diff をレビューし、以下の観点でコメントを書いてください:\n' +
  '1. 設計・アーキテクチャ\n' +
  '2. 命名・可読性\n' +
  '3. エラーハンドリング\n' +
  '4. セキュリティ(秘匿情報・インジェクション・認証認可)\n' +
  '5. テストの不足\n' +
  '6. 具体的な改善提案 (行レベルで)\n' +
  '形式は Markdown。各観点の見出しは ## 。\n' +
  "指摘がない観点は『指摘なし』と書く。\n" +
  '冒頭に 3 行以内の総評を書く。\n' +
  '最後に LGTM / 要修正 / ブロッキング のいずれかで判定';

function buildUserMessage({ title, body, diff }) {
  return (
    `## PR タイトル\n${title}\n\n` +
    `## PR 本文\n${body || '(なし)'}\n\n` +
    `## diff\n\`\`\`diff\n${diff}\n\`\`\``
  );
}

function truncateDiff(diff) {
  if (diff.length <= DIFF_MAX_CHARS) return diff;
  return diff.slice(0, DIFF_MAX_CHARS) + '\n\n[truncated]';
}

// ── CLI args ───────────────────────────────────────────────────────────────

const argv        = process.argv.slice(2);
const dryRun      = argv.includes('--dry-run');
const dfIdx       = argv.indexOf('--diff-file');
const diffFileArg = dfIdx !== -1 ? argv[dfIdx + 1] : null;

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // ── Dry-run mode ──────────────────────────────────────────────────────────

  if (dryRun) {
    if (!diffFileArg) {
      console.error('Error: --dry-run には --diff-file <パス> が必要です。');
      return 1;
    }
    const absPath = resolve(process.cwd(), diffFileArg);
    if (!existsSync(absPath)) {
      console.error(`Error: diff ファイルが見つかりません: ${absPath}`);
      return 1;
    }

    const diff = truncateDiff(readFileSync(absPath, 'utf-8'));
    process.stderr.write('[dry-run] Claude API にレビューを依頼しています ... ');

    const review = await runPrompt({
      system: SYSTEM_PROMPT,
      user: buildUserMessage({ title: '[dry-run] local diff', body: '', diff }),
      maxTokens: 4096,
    });

    process.stderr.write('完了\n\n');
    console.log(`${REVIEW_HEADER}\n\n${review}`);
    return 0;
  }

  // ── GitHub Actions mode ───────────────────────────────────────────────────

  const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
  const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
  const GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH;

  if (!GITHUB_TOKEN)      { console.error('Error: GITHUB_TOKEN が未設定です。');      return 1; }
  if (!GITHUB_REPOSITORY) { console.error('Error: GITHUB_REPOSITORY が未設定です。'); return 1; }
  if (!GITHUB_EVENT_PATH) { console.error('Error: GITHUB_EVENT_PATH が未設定です。'); return 1; }

  const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf-8'));
  const pr    = event.pull_request;

  if (!pr) {
    console.log('PR イベントではありません。スキップします。');
    return 0;
  }

  if (pr.user?.type === 'Bot') {
    console.log(`Bot ユーザー (${pr.user.login}) からの PR のためスキップします。`);
    return 0;
  }

  const prTitle = pr.title ?? '';
  const prBody  = pr.body  ?? '';
  if (prTitle.includes('[skip-review]') || prBody.includes('[skip-review]')) {
    console.log('[skip-review] が検出されたためスキップします。');
    return 0;
  }

  const [owner, repo] = GITHUB_REPOSITORY.split('/');
  const prNumber      = pr.number;
  const octokit       = new Octokit({ auth: GITHUB_TOKEN });

  console.log(`PR #${prNumber} の diff を取得しています ...`);
  const diffRes = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });

  const rawDiff = typeof diffRes.data === 'string' ? diffRes.data : JSON.stringify(diffRes.data);
  const diff    = truncateDiff(rawDiff);
  if (rawDiff.length > DIFF_MAX_CHARS) {
    console.log(`diff が ${DIFF_MAX_CHARS} 文字を超えたため切り詰めました。`);
  }

  console.log('Claude API にレビューを依頼しています ...');
  const review = await runPrompt({
    system: SYSTEM_PROMPT,
    user: buildUserMessage({ title: prTitle, body: prBody, diff }),
    maxTokens: 4096,
  });

  if (!review || review.trim().length === 0) {
    console.error('Error: Claude API からの応答が空でした。');
    return 1;
  }

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `${REVIEW_HEADER}\n\n${review}`,
  });

  console.log(`PR #${prNumber} にレビューコメントを投稿しました。`);
  return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
