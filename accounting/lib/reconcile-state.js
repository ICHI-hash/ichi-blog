'use strict';
const fs   = require('fs');
const path = require('path');

const { pathForState } = require('../../lib/paths.js');
const RECONCILED_FILE = pathForState('accounting', 'reconciled.json');

function atomicWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filepath);
}

/** state/reconciled.json を読み込む。存在しない場合は { matches: [] } を返す。 */
function loadReconciled() {
  try {
    return JSON.parse(fs.readFileSync(RECONCILED_FILE, 'utf8'));
  } catch {
    return { matches: [] };
  }
}

/** state/reconciled.json を保存する(アトミック書き込み)。 */
function saveReconciled(data) {
  fs.mkdirSync(path.dirname(RECONCILED_FILE), { recursive: true });
  atomicWrite(RECONCILED_FILE, data);
}

function isInvoiceReconciled(invoiceNumber) {
  return (loadReconciled().matches || []).some(m => m.invoice_number === invoiceNumber);
}

function isTransactionReconciled(hash) {
  return (loadReconciled().matches || []).some(m => m.transaction_hash === hash);
}

/**
 * マッチ結果を reconciled.json に追記する。
 * 同一 invoice_number または同一 transaction_hash が既に存在する場合は警告を出してスキップ。
 * @param {{ invoice_number, transaction_hash, matched_amount, matched_at, method, note }} entry
 * @returns {boolean} 追記できた場合 true
 */
function recordMatch(entry) {
  const data = loadReconciled();
  if (!Array.isArray(data.matches)) data.matches = [];

  if (data.matches.some(m => m.invoice_number === entry.invoice_number)) {
    process.stderr.write(`[warn] 重複スキップ: ${entry.invoice_number} は既に消込済みです\n`);
    return false;
  }
  if (data.matches.some(m => m.transaction_hash === entry.transaction_hash)) {
    process.stderr.write(`[warn] 重複スキップ: transaction_hash ${entry.transaction_hash} は既に記録済みです\n`);
    return false;
  }

  data.matches.push(entry);
  saveReconciled(data);
  return true;
}

module.exports = { loadReconciled, saveReconciled, isInvoiceReconciled, isTransactionReconciled, recordMatch };
