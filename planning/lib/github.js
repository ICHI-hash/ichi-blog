'use strict';

// B 案(新規実装): engineering/scripts/pr-review.js は Octokit を直接使用し lib 化されていない。
// planning 向けに同じ GITHUB_TOKEN / @octokit/rest を使う薄いラッパーを新規実装する。
//
// 必要な環境変数:
//   GITHUB_TOKEN … GitHub Personal Access Token (read:repo 権限)

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

let _octokit;

function getClient() {
  if (!process.env.GITHUB_TOKEN) return null;
  if (!_octokit) {
    const { Octokit } = require('@octokit/rest');
    _octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  }
  return _octokit;
}

function isEnabled() {
  return Boolean(process.env.GITHUB_TOKEN);
}

/**
 * getRepoSnapshot(owner, repo)
 * → { openIssues, closedIssues30d, openPRs, mergedPRs30d, lastCommitAt, defaultBranch }
 * | { error: string }
 *
 * 取得失敗時は throw せず { error } を含むオブジェクトを返す。
 * 直近 30 日のクローズ済み Issue / マージ済み PR を集計する。
 */
async function getRepoSnapshot(owner, repo) {
  const client = getClient();
  if (!client) return { error: 'GITHUB_TOKEN が設定されていません' };

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // 並列でリポジトリ情報・PR 一覧を取得
    const [
      { data: repoData },
      { data: openPRs },
      { data: closedPRs },
      { data: closedIssuesRaw },
    ] = await Promise.all([
      client.repos.get({ owner, repo }),
      client.pulls.list({ owner, repo, state: 'open', per_page: 100 }),
      client.pulls.list({ owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 }),
      client.issues.listForRepo({ owner, repo, state: 'closed', since: thirtyDaysAgo, per_page: 100 }),
    ]);

    // PR を除いた Issue のみカウント
    const closedIssues30d = closedIssuesRaw.filter(i => !i.pull_request).length;

    // 30 日以内にマージされた PR
    const mergedPRs30d = closedPRs.filter(
      pr => pr.merged_at && pr.merged_at >= thirtyDaysAgo
    ).length;

    return {
      openIssues:    Math.max(0, repoData.open_issues_count - openPRs.length),
      closedIssues30d,
      openPRs:       openPRs.length,
      mergedPRs30d,
      lastCommitAt:  repoData.pushed_at ? repoData.pushed_at.split('T')[0] : null,
      defaultBranch: repoData.default_branch,
    };
  } catch (err) {
    const msg = err.status === 404
      ? `リポジトリ ${owner}/${repo} が見つかりません (404)`
      : err.status === 403
        ? `アクセス権限がありません (403)。GITHUB_TOKEN のスコープを確認してください`
        : (err.message ?? String(err));
    return { error: msg };
  }
}

/**
 * getRepoActivity(owner, repo, { since, until })
 * → { commits, mergedPRs, closedIssues, summary, truncated }
 * | { error, commits: [], mergedPRs: [], closedIssues: [], summary: {...} }
 *
 * since / until は ISO 8601 文字列 (YYYY-MM-DDTHH:MM:SSZ)。
 * 取得失敗時は throw せず error フィールドを含むオブジェクトを返す。
 *
 * commits:      Array<{ sha, message, author, date, url }>        最大 100 件
 * mergedPRs:    Array<{ number, title, mergedAt, author, url, baseBranch }>
 * closedIssues: Array<{ number, title, closedAt, author, url, labels }>
 * summary:      { commitCount, mergedPRCount, closedIssueCount, contributors: string[] }
 * truncated:    commits が 100 件上限に達した場合 true
 */
async function getRepoActivity(owner, repo, { since, until }) {
  const empty = { commits: [], mergedPRs: [], closedIssues: [],
                  summary: { commitCount: 0, mergedPRCount: 0, closedIssueCount: 0, contributors: [] } };
  const client = getClient();
  if (!client) return { ...empty, error: 'GITHUB_TOKEN が設定されていません' };

  try {
    const [
      { data: rawCommits },
      { data: closedPRsRaw },
      { data: closedIssuesRaw },
    ] = await Promise.all([
      client.repos.listCommits({ owner, repo, since, until, per_page: 100 }),
      client.pulls.list({ owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 }),
      client.issues.listForRepo({ owner, repo, state: 'closed', since, per_page: 100 }),
    ]);

    const truncated = rawCommits.length >= 100;

    const commits = rawCommits.map(c => ({
      sha:     c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0].slice(0, 120),
      author:  c.commit.author?.name ?? c.author?.login ?? '不明',
      date:    (c.commit.author?.date ?? '').split('T')[0],
      url:     c.html_url,
    }));

    const mergedPRs = closedPRsRaw
      .filter(pr => pr.merged_at && pr.merged_at >= since && pr.merged_at <= until)
      .map(pr => ({
        number:     pr.number,
        title:      pr.title,
        mergedAt:   (pr.merged_at ?? '').split('T')[0],
        author:     pr.user?.login ?? '不明',
        url:        pr.html_url,
        baseBranch: pr.base?.ref ?? '',
      }));

    const closedIssues = closedIssuesRaw
      .filter(i => !i.pull_request && i.closed_at >= since && i.closed_at <= until)
      .map(i => ({
        number:   i.number,
        title:    i.title,
        closedAt: (i.closed_at ?? '').split('T')[0],
        author:   i.user?.login ?? '不明',
        url:      i.html_url,
        labels:   i.labels.map(l => l.name),
      }));

    const contributors = [...new Set([
      ...commits.map(c => c.author),
      ...mergedPRs.map(pr => pr.author),
      ...closedIssues.map(i => i.author),
    ].filter(Boolean))];

    return {
      commits, mergedPRs, closedIssues, truncated,
      summary: { commitCount: commits.length, mergedPRCount: mergedPRs.length,
                 closedIssueCount: closedIssues.length, contributors },
    };
  } catch (err) {
    const msg = err.status === 404
      ? `リポジトリ ${owner}/${repo} が見つかりません (404)`
      : err.status === 403
        ? `アクセス権限がありません (403)。GITHUB_TOKEN のスコープを確認してください`
        : (err.message ?? String(err));
    return { ...empty, error: msg };
  }
}

module.exports = { isEnabled, getClient, getRepoSnapshot, getRepoActivity };
