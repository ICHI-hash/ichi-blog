'use strict';
const fs   = require('fs');
const path = require('path');

const INDEX_FILE = path.resolve(__dirname, '../state/receipts-index.json');

function atomicWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filepath);
}

/** state/receipts-index.json を読む。存在しない場合は { receipts: [] } を返す。 */
function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return { receipts: [] };
  }
}

/** state/receipts-index.json を保存する(アトミック書き込み)。 */
function saveIndex(data) {
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  atomicWrite(INDEX_FILE, data);
}

/**
 * エントリ配列を receipts-index.json に追記する。
 * 各エントリスキーマ:
 *   id, saved_path, source, source_message_id, vendor, amount, date,
 *   tax_amount, registration_number, confidence, needs_review,
 *   ocr_raw_text (200 文字以内), added_at
 * @param {object[]} entries
 */
function addReceipts(entries) {
  const data = loadIndex();
  if (!Array.isArray(data.receipts)) data.receipts = [];
  data.receipts.push(...entries);
  saveIndex(data);
}

/**
 * Gmail メッセージ ID でエントリを検索する。
 * @param {string} messageId
 * @returns {object[]}
 */
function findByMessageId(messageId) {
  return loadIndex().receipts.filter(r => r.source_message_id === messageId);
}

/**
 * 保存パスでエントリを検索する(ローカル重複防止)。
 * @param {string} savedPath
 * @returns {object|undefined}
 */
function findByPath(savedPath) {
  return loadIndex().receipts.find(r => r.saved_path === savedPath);
}

module.exports = { loadIndex, saveIndex, addReceipts, findByMessageId, findByPath };
