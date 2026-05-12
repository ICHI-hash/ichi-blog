'use strict';

const matter = require('gray-matter');

// STEP 5 / STEP 6 / STEP 7 で共有するパーサ。
// planning/inputs/roadmap.md から ### M-XXX: 形式のマイルストーンを抽出する。

const MILESTONE_RE = /^### (M-\d{3,}): (.+)$/;
const KV_RE        = /^- (\w+): (.*)$/;
const VALID_STATUSES = new Set(['未着手', '進行中', '完了', '遅延']);

/**
 * parseRoadmap(markdown) → { frontmatter: object, milestones: Array<Milestone> }
 *
 * Milestone: { id, name, deadline, status, related_projects, progress_note, blockers, rawBody }
 *   - related_projects: カンマ分割・trim 済みの string[]
 *   - rawBody: 見出し直下の箇条書き行をそのまま結合した文字列
 *
 * - M-ID 重複 → 警告ログ、両方保持
 * - ステータス値が許容外 → 警告ログ、値はそのまま保持
 * - 必須フィールド欠落 → 警告ログ、可能な範囲でパース
 * - マイルストーン 0 件 → Error を throw
 */
function parseRoadmap(markdown) {
  const { data: frontmatter, content } = matter(markdown);
  const lines = content.split('\n');
  const milestones = [];
  const seenIds = new Set();

  let current = null;
  let bodyLines = [];

  function flush() {
    if (!current) return;
    const rawBody = bodyLines.join('\n').trim();
    const fields = {};
    for (const line of bodyLines) {
      const m = KV_RE.exec(line.trim());
      if (m) fields[m[1].trim()] = m[2].trim();
    }

    // 必須フィールドの存在チェック
    for (const f of ['id', 'deadline', 'status']) {
      if (!fields[f]) {
        console.warn(`[roadmap-parser] Warning: M-ID "${current.id}" の "${f}" フィールドが見つかりません。`);
      }
    }

    // ステータス値チェック
    if (fields.status && !VALID_STATUSES.has(fields.status)) {
      console.warn(
        `[roadmap-parser] Warning: M-ID "${current.id}" のステータス "${fields.status}" は ` +
        `許容値(${[...VALID_STATUSES].join(' / ')})外です。値はそのまま保持します。`
      );
    }

    // related_projects をカンマ分割
    const related = fields.related_projects
      ? fields.related_projects.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    milestones.push({
      id:               fields.id ?? current.id,
      name:             fields.name ?? current.name,
      deadline:         fields.deadline ?? '',
      status:           fields.status ?? '',
      related_projects: related,
      progress_note:    fields.progress_note ?? '',
      blockers:         fields.blockers ?? '',
      rawBody,
    });

    current = null;
    bodyLines = [];
  }

  for (const line of lines) {
    const m = MILESTONE_RE.exec(line);
    if (m) {
      flush();
      const id   = m[1];
      const name = m[2].trim();
      if (seenIds.has(id)) {
        console.warn(`[roadmap-parser] Warning: M-ID "${id}" が重複しています。全件保持します。`);
      }
      seenIds.add(id);
      current = { id, name };
    } else if (current) {
      // ## 以上の見出しが現れたら現在のマイルストーンを終了
      if (/^## /.test(line)) {
        flush();
      } else {
        bodyLines.push(line);
      }
    }
  }
  flush();

  if (milestones.length === 0) {
    throw new Error(
      'マイルストーンセクション `### M-XXX:` が見つかりません。入力ファイルの形式を確認してください。'
    );
  }

  return { frontmatter, milestones };
}

/**
 * formatMilestone(milestone) → Markdown 文字列
 *
 * マスタ形式に準じた見出し + 箇条書きに再構築する。
 * 出力の `## ロードマップ(マスタ反映)` セクション構築などに使用。
 */
function formatMilestone(m) {
  const projects = m.related_projects.length > 0 ? m.related_projects.join(', ') : 'なし';
  return [
    `### ${m.id}: ${m.name}`,
    '',
    `- id: ${m.id}`,
    `- name: ${m.name}`,
    `- deadline: ${m.deadline || '未設定'}`,
    `- status: ${m.status || '不明'}`,
    `- related_projects: ${projects}`,
    `- progress_note: ${m.progress_note || '(未記載)'}`,
    `- blockers: ${m.blockers || '(未記載)'}`,
  ].join('\n');
}

module.exports = { parseRoadmap, formatMilestone };
