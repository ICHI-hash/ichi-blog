'use strict';
const fs   = require('fs');
const path = require('path');

const FETCH_STATE_FILE = path.resolve(__dirname, '../state/receipt-fetch.json');

function atomicWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filepath);
}

function toJSTISOString() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00');
}

/** state/receipt-fetch.json を読む。存在しない場合は { processed: {} } を返す。 */
function loadProcessed() {
  try {
    return JSON.parse(fs.readFileSync(FETCH_STATE_FILE, 'utf8'));
  } catch {
    return { processed: {} };
  }
}

/** state/receipt-fetch.json を保存する(アトミック書き込み)。 */
function saveProcessed(data) {
  fs.mkdirSync(path.dirname(FETCH_STATE_FILE), { recursive: true });
  atomicWrite(FETCH_STATE_FILE, data);
}

/**
 * 指定 Gmail メッセージ ID が処理済みか確認する。
 * @param {string} messageId
 * @returns {boolean}
 */
function isProcessed(messageId) {
  return Object.prototype.hasOwnProperty.call(loadProcessed().processed, messageId);
}

/**
 * 処理済み記録を追記する。
 * @param {{
 *   messageId: string,
 *   subject: string,
 *   from: string,
 *   attachments_count: number,
 *   saved_paths: string[],
 *   ocr_results: object[]
 * }} entry
 */
function recordProcessed(entry) {
  const data = loadProcessed();
  data.processed[entry.messageId] = {
    processed_at:      toJSTISOString(),
    subject:           entry.subject          || '',
    from:              entry.from             || '',
    attachments_count: entry.attachments_count || 0,
    saved_paths:       entry.saved_paths       || [],
    ocr_results:       entry.ocr_results       || [],
  };
  saveProcessed(data);
}

module.exports = { loadProcessed, saveProcessed, isProcessed, recordProcessed };
