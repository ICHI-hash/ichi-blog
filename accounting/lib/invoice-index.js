'use strict';
const fs   = require('fs');
const path = require('path');

const { pathForOutputs } = require('../../lib/paths.js');
const INVOICES_DIR = pathForOutputs('accounting', 'invoices');

/**
 * outputs/invoices/*.meta.json を全件読み込み、配列で返す。
 * 破損 JSON はスキップし stderr に警告を出す。
 * @returns {Array<object>}
 */
function loadAllInvoices() {
  let files;
  try {
    files = fs.readdirSync(INVOICES_DIR).filter(f => f.endsWith('.meta.json'));
  } catch {
    return [];
  }

  const invoices = [];
  for (const file of files) {
    const filepath = path.resolve(INVOICES_DIR, file);
    try {
      const meta = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      const { invoice_number, billed_amount, client_name, issue_date, due_date } = meta;
      if (!invoice_number || billed_amount == null || !client_name || !issue_date || !due_date) {
        process.stderr.write(`[warn] 必須フィールド不足のためスキップ: ${file}\n`);
        continue;
      }
      invoices.push(meta);
    } catch (err) {
      process.stderr.write(`[warn] meta.json 読み込み失敗 (${file}): ${err.message}\n`);
    }
  }
  return invoices;
}

/**
 * 既消込済みの請求書を除いた配列を返す。
 * @param {Array<object>} invoices - loadAllInvoices() の結果
 * @param {{ matches: Array<{invoice_number: string}> }} reconciled - loadReconciled() の結果
 * @returns {Array<object>}
 */
function filterUnreconciled(invoices, reconciled) {
  const done = new Set((reconciled.matches || []).map(m => m.invoice_number));
  return invoices.filter(inv => !done.has(inv.invoice_number));
}

module.exports = { loadAllInvoices, filterUnreconciled };
