'use strict';

const matter = require('gray-matter');

// STEP 2 / STEP 3 / STEP 6 / STEP 7 で共有するパーサ。
// 要件定義書・機能リストから ### F-XXX: 形式のエントリを抽出する。

const FEATURE_RE = /^### (F-\d{3,}): (.+)$/;

/**
 * parseFeatures(markdown) → Array<{ id, name, body }>
 *
 * body = 次の ### F-XXX: 見出しまたはファイル末尾までの本文(trim 済み)。
 * F-ID が重複している場合は警告ログを出しつつ全件保持。
 * 機能が 0 件の場合は Error を throw する。
 */
function parseFeatures(markdown) {
  const lines = markdown.split('\n');
  const features = [];
  const seenIds = new Set();

  let current = null;
  let bodyLines = [];

  function flush() {
    if (current) {
      features.push({ id: current.id, name: current.name, body: bodyLines.join('\n').trim() });
      current = null;
      bodyLines = [];
    }
  }

  for (const line of lines) {
    const m = FEATURE_RE.exec(line);
    if (m) {
      flush();
      const id = m[1];
      const name = m[2].trim();
      if (seenIds.has(id)) {
        console.warn(`[parser] Warning: F-ID "${id}" が重複しています。全件保持します。`);
      }
      seenIds.add(id);
      current = { id, name };
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();

  if (features.length === 0) {
    throw new Error(
      '機能セクション `### F-XXX:` が見つかりません。入力ファイルの形式を確認してください。'
    );
  }

  return features;
}

/**
 * parseFrontmatter(markdown) → object
 *
 * YAML frontmatter を gray-matter でパースして返す。frontmatter がなければ空オブジェクト。
 */
function parseFrontmatter(markdown) {
  return matter(markdown).data;
}

module.exports = { parseFeatures, parseFrontmatter };
