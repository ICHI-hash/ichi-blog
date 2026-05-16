'use strict';

// 全角英数字 → 半角 (U+FF01-FF5E → U+0021-007E)
function toHalfWidth(s) {
  return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/**
 * 振込人名マッチ用の正規化。
 * - 前後空白除去・連続空白→1個
 * - 全角英数→半角
 * - 法人格表記を除去
 * - 振込時の慣用カナ表記 (ｶ) を除去
 * - 英字を大文字化
 * 半角カナ・全角カナはそのまま維持する。
 */
function normalizeName(s) {
  if (!s) return '';
  let t = String(s).trim();
  t = toHalfWidth(t);
  // 法人格除去
  t = t.replace(/株式会社|有限会社|合同会社/g, '');
  t = t.replace(/\(株\)|\(有\)|\(合\)|（株）|（有）|（合）/g, '');
  // 末尾の "(ｶ" や "（ｶ" 等（閉じ括弧なし）を除去
  t = t.replace(/[\(（][カｶ]\s*$/, '');
  // "(ｶ)" "(カ)" 等（閉じ括弧あり）を除去
  t = t.replace(/[\(（][カｶ][\)）]/g, '');
  // 英字を大文字化（日本語文字には影響しない）
  t = t.toUpperCase();
  // 連続空白を1個に
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// Jaro 距離 (0..1)
function jaro(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchDist = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
}

/**
 * Jaro-Winkler 類似度 (0..1)。
 * p=0.1 固定 (標準値)。
 */
function jaroWinkler(a, b) {
  const j = jaro(a, b);
  let prefixLen = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefixLen++;
    else break;
  }
  return j + prefixLen * 0.1 * (1 - j);
}

/**
 * target に最も類似する candidates[i] を返す。
 * @returns {{ name: string, score: number, index: number }}
 */
function bestMatch(target, candidates) {
  let best = { name: '', score: -1, index: -1 };
  const normTarget = normalizeName(target);
  candidates.forEach((c, i) => {
    const score = jaroWinkler(normTarget, normalizeName(c));
    if (score > best.score) best = { name: c, score, index: i };
  });
  return best;
}

module.exports = { normalizeName, jaroWinkler, bestMatch };
