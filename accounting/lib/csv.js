'use strict';
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// ------------------------------------------------------------------ constants

const FORMAT_SIGNATURES = {
  moneyforward: ['計算対象', '日付', '内容', '金額(円)', '保有金融機関', '大項目', '中項目'],
  freee:        ['発生日', '勘定科目', '税区分', '金額', '備考', '取引先'],
  mufg:         ['日付', '摘要', '摘要内容', 'お支払金額', 'お預り金額', '差引残高'],
};

// ------------------------------------------------------------------ helpers

/** "YYYY/MM/DD" or "YYYY-MM-DD" → "YYYY-MM-DD" (タイムゾーン非依存) */
function normalizeDateStr(str) {
  if (!str) return '';
  return str.trim().replace(/\//g, '-').slice(0, 10);
}

/**
 * 金額文字列を整数に変換する。
 * ¥ / カンマ / 全角スペースを除去してから parse。
 * 解析不能の場合は null を返す。
 */
function parseAmount(str) {
  if (str === null || str === undefined) return null;
  const cleaned = String(str).replace(/[¥￥,\s]/g, '').trim();
  if (cleaned === '' || cleaned === '-') return null;
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? null : n;
}

// ------------------------------------------------------------------ core CSV

/**
 * CSV ファイルをパースして行の配列を返す。
 * BOM 除去・空行スキップを自動適用する。
 * encoding: 'sjis' を指定すると iconv-lite で UTF-8 に変換する。
 * @param {string} filepath
 * @param {object} [options]
 * @returns {Array}
 */
function parseCSV(filepath, options = {}) {
  const { encoding, ...parseOptions } = options;
  let content;
  if (encoding === 'sjis') {
    const iconv = require('iconv-lite');
    const buffer = fs.readFileSync(filepath);
    content = iconv.decode(buffer, 'Shift_JIS');
  } else {
    content = fs.readFileSync(filepath, 'utf8');
  }
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1); // BOM 除去
  return parse(content, { skip_empty_lines: true, ...parseOptions });
}

/**
 * オブジェクト配列を CSV ファイルに書き出す(UTF-8 with BOM)。
 * Excel での文字化けを防ぐため BOM を付与する。
 * @param {Array<object>} rows
 * @param {string} filepath
 */
function writeCSV(rows, filepath) {
  const content = stringify(rows, { header: true });
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, '﻿' + content, 'utf8');
}

// ------------------------------------------------------------------ format detection

/**
 * 銀行 CSV のヘッダ配列を見てフォーマット名を返す。
 * 各形式のシグネチャと 60% 以上一致した場合にその形式と判定する。
 * @param {string[]} headers
 * @returns {"moneyforward"|"freee"|"mufg"|"unknown"}
 */
function detectFormat(headers) {
  const set = new Set(headers.map(h => h.trim()));
  let best = { name: 'unknown', score: 0 };
  for (const [name, sig] of Object.entries(FORMAT_SIGNATURES)) {
    const hits = sig.filter(h => set.has(h)).length;
    if (hits >= Math.ceil(sig.length * 0.6) && hits > best.score) {
      best = { name, score: hits };
    }
  }
  return best.name;
}

// ------------------------------------------------------------------ normalizers

/**
 * MoneyForward ME エクスポート CSV を共通スキーマに変換する。
 * 支出は負値 → 正に反転。収入は正値 → 負のまま。
 */
function normalizeMoneyforward(row) {
  const rawAmount = parseAmount(row['金額(円)'] ?? row['金額'] ?? null);
  if (rawAmount === null) {
    process.stderr.write(`[warn] 金額解析失敗 (moneyforward): ${JSON.stringify(row)}\n`);
    return null;
  }
  return {
    date:        normalizeDateStr(row['日付'] || ''),
    description: (row['内容'] || '').trim(),
    amount:      -rawAmount, // MF は支出が負値 → 正に反転
    raw:         row,
  };
}

/**
 * Freee 会計 取引一覧 CSV を共通スキーマに変換する。
 */
function normalizeFreee(row) {
  const rawAmount = parseAmount(row['金額'] ?? null);
  if (rawAmount === null) {
    process.stderr.write(`[warn] 金額解析失敗 (freee): ${JSON.stringify(row)}\n`);
    return null;
  }
  const desc = (row['備考'] || row['取引先'] || '').trim();
  return {
    date:        normalizeDateStr(row['発生日'] || ''),
    description: desc,
    amount:      rawAmount, // Freee は支出が正値
    raw:         row,
  };
}

/**
 * 三菱 UFJ 銀行 入出金明細 CSV を共通スキーマに変換する。
 * お支払金額(出金) → 正、お預り金額(入金) → 負。
 */
function normalizeMufg(row) {
  const outVal = parseAmount(row['お支払金額'] ?? null);
  const inVal  = parseAmount(row['お預り金額']  ?? null);

  let amount;
  if (outVal !== null && outVal > 0) {
    amount = outVal;        // 支出: 正
  } else if (inVal !== null && inVal > 0) {
    amount = -inVal;        // 収入: 負
  } else {
    process.stderr.write(`[warn] 金額解析失敗 (mufg): ${JSON.stringify(row)}\n`);
    return null;
  }

  const desc = [row['摘要'] || '', row['摘要内容'] || ''].filter(Boolean).join(' ').trim();
  return {
    date:        normalizeDateStr(row['日付'] || ''),
    description: desc,
    amount,
    raw:         row,
  };
}

/**
 * 不明形式向け手動マッピングで正規化する。
 * @param {object} row
 * @param {{ date_col, description_col, amount_col, amount_in_col?, sign }} mapping
 */
function normalizeManual(row, mapping) {
  const { date_col, description_col, amount_col, amount_in_col, sign = 'expense_positive' } = mapping;

  const outVal = parseAmount(row[amount_col] ?? null);
  const inVal  = amount_in_col ? parseAmount(row[amount_in_col] ?? null) : null;

  let amount;
  if (sign === 'expense_positive') {
    if (outVal !== null && outVal > 0)       amount = outVal;
    else if (inVal !== null && inVal > 0)    amount = -inVal;
    else return null;
  } else {
    // expense_negative: 出金列の値は負 → 正に反転
    if (outVal !== null) amount = -outVal;
    else return null;
  }

  return {
    date:        normalizeDateStr(String(row[date_col] || '')),
    description: (String(row[description_col] || '')).trim(),
    amount,
    raw:         row,
  };
}

// ------------------------------------------------------------------ high-level API

/**
 * CSV ファイルを読み込み、共通スキーマのトランザクション配列に変換する。
 * @param {string} filepath
 * @param {{ encoding?, format?, manualMapping? }} [opts]
 * @returns {{ format: string, transactions: Array }}
 */
function parseTransactionsFromCSV(filepath, opts = {}) {
  const { encoding, format: forcedFormat, manualMapping } = opts;

  // ヘッダ読み取りで形式判定
  const rawRows = parseCSV(filepath, { encoding, columns: false });
  if (rawRows.length < 2) throw new Error('CSV にデータ行がありません');
  const headers = rawRows[0];

  const format = forcedFormat || detectFormat(headers);

  // columns 付きで行データ取得
  const rows = parseCSV(filepath, { encoding, columns: true });

  const normalizeMap = {
    moneyforward: normalizeMoneyforward,
    freee:        normalizeFreee,
    mufg:         normalizeMufg,
    manual:       row => normalizeManual(row, manualMapping),
  };

  const effectiveFormat = format === 'unknown' ? 'manual' : format;
  const normalize = normalizeMap[effectiveFormat];

  if (!normalize) {
    throw new Error(`未対応の形式です: ${format}。--format manual と --manual-mapping を指定してください。`);
  }
  if (effectiveFormat === 'manual' && !manualMapping) {
    throw new Error('manual 形式には --manual-mapping <json ファイルパス> が必要です。');
  }

  const transactions = [];
  rows.forEach((row, i) => {
    try {
      const tx = normalize(row);
      if (tx !== null) transactions.push(tx);
    } catch (err) {
      process.stderr.write(`[warn] 行 ${i + 2}: スキップ (${err.message})\n`);
    }
  });

  return { format: effectiveFormat, transactions };
}

module.exports = {
  parseCSV,
  writeCSV,
  detectFormat,
  normalizeMoneyforward,
  normalizeFreee,
  normalizeMufg,
  normalizeManual,
  parseTransactionsFromCSV,
  FORMAT_SIGNATURES,
};
