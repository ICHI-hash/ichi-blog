'use strict';

const matter = require('gray-matter');

// STEP 6 / STEP 7 で共有するパーサ。
// planning/inputs/projects.md から ### <コード>: 形式の案件エントリを抽出する。

const PROJECT_RE = /^### ([A-Z0-9][A-Z0-9-]+): (.+)$/;
const KV_RE      = /^- (\w+): (.*)$/;
const VALID_STATUSES = new Set(['提案中', '進行中', '保守', '完了', '休止']);

/**
 * parseProjects(markdown) → { frontmatter: object, projects: Array<Project> }
 *
 * Project: { project_code, project_name, client, repos, sheets_id, roadmap_ids, requirements_path, status, rawBody }
 *   - repos:       string[] (owner/repo 形式)
 *   - roadmap_ids: string[]
 *
 * - 必須フィールド欠落 → 警告ログ、可能な範囲でパース
 * - ステータス値が許容外 → 警告ログ、値はそのまま保持
 * - 案件 0 件 → Error を throw
 */
function parseProjects(markdown) {
  const { data: frontmatter, content } = matter(markdown);
  const lines = content.split('\n');
  const projects = [];
  const seenCodes = new Set();

  let current = null;
  let bodyLines = [];

  function flush() {
    if (!current) return;

    const fields = {};
    for (const line of bodyLines) {
      const m = KV_RE.exec(line.trim());
      if (m) fields[m[1].trim()] = m[2].trim();
    }

    const required = ['project_code', 'project_name', 'client', 'status'];
    for (const f of required) {
      if (!fields[f]) {
        console.warn(`[projects-parser] Warning: "${current.code}" の "${f}" フィールドが見つかりません。`);
      }
    }

    if (fields.status && !VALID_STATUSES.has(fields.status)) {
      console.warn(
        `[projects-parser] Warning: "${current.code}" のステータス "${fields.status}" は ` +
        `許容値(${[...VALID_STATUSES].join(' / ')})外です。`
      );
    }

    const splitTrimmed = v => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : []);

    projects.push({
      project_code:      fields.project_code ?? current.code,
      project_name:      fields.project_name ?? current.name,
      client:            fields.client ?? '',
      repos:             splitTrimmed(fields.repos),
      sheets_id:         fields.sheets_id ?? '',
      roadmap_ids:       splitTrimmed(fields.roadmap_ids),
      requirements_path: fields.requirements_path ?? '',
      status:            fields.status ?? '',
      rawBody:           bodyLines.join('\n').trim(),
    });

    current = null;
    bodyLines = [];
  }

  for (const line of lines) {
    const m = PROJECT_RE.exec(line);
    if (m) {
      flush();
      const code = m[1];
      const name = m[2].trim();
      if (seenCodes.has(code)) {
        console.warn(`[projects-parser] Warning: 案件コード "${code}" が重複しています。全件保持します。`);
      }
      seenCodes.add(code);
      current = { code, name };
    } else if (current) {
      if (/^## /.test(line)) {
        flush();
      } else {
        bodyLines.push(line);
      }
    }
  }
  flush();

  if (projects.length === 0) {
    throw new Error(
      '案件セクション `### <コード>: <名前>` が見つかりません。入力ファイルの形式を確認してください。'
    );
  }

  return { frontmatter, projects };
}

module.exports = { parseProjects };
