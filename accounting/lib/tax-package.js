'use strict';
const fs     = require('fs');
const path   = require('path');
const matter = require('gray-matter');

const { parseCSV, writeCSV } = require('./csv');

const { pathForInputs, pathForState, pathForOutputs } = require('../../lib/paths.js');
const INVOICES_DIR   = pathForOutputs('accounting', 'invoices');
const CATEGORIZE_DIR = pathForOutputs('accounting', 'categorize');
const RECONCILE_DIR  = pathForOutputs('accounting', 'reconcile');
const BANK_DIR       = pathForInputs('accounting', 'bank-csv');
const PAYABLES_DIR   = pathForInputs('accounting', 'payables');
const RECONCILED_FILE = pathForState('accounting', 'reconciled.json');

function safeReadDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function toDateStr(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

// ------------------------------------------------------------------ collect

/**
 * 指定月のファイル群を集約する純粋関数(副作用なし、冪等)。
 * @param {string} yyyymm - "2026-05"
 * @param {{ baseDir?: string }} opts
 */
function collectForMonth(yyyymm, opts = {}) {
  const RECEIPTS_DIR  = pathForInputs('accounting', 'receipts', yyyymm);
  const REPORT_PATH   = pathForOutputs('accounting', 'monthly-reports', `${yyyymm}.md`);

  // --- 1. 売上請求書 ---
  const invoices = [];
  for (const file of safeReadDir(INVOICES_DIR).filter(f => f.endsWith('.meta.json'))) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.resolve(INVOICES_DIR, file), 'utf8'));
      if (!String(meta.issue_date || '').startsWith(yyyymm)) continue;
      const pdfPath = path.resolve(INVOICES_DIR, `${meta.invoice_number}.pdf`);
      invoices.push({ meta, pdf_path: fs.existsSync(pdfPath) ? pdfPath : null });
    } catch { /* skip */ }
  }
  const total_billed      = invoices.reduce((s, i) => s + (i.meta.billed_amount || 0), 0);
  const total_subtotal    = invoices.reduce((s, i) => s + (i.meta.subtotal       || 0), 0);
  const total_tax         = invoices.reduce((s, i) => s + (i.meta.tax_total      || 0), 0);
  const total_withholding = invoices.reduce((s, i) => s + (i.meta.withholding    || 0), 0);

  // --- 2. 経費エントリ CSV ---
  const entries_csvs = safeReadDir(CATEGORIZE_DIR)
    .filter(f => f.endsWith('.entries.csv'))
    .map(f => path.resolve(CATEGORIZE_DIR, f));

  const consolidated_rows = [];
  for (const fp of entries_csvs) {
    try {
      for (const row of parseCSV(fp, { columns: true })) {
        if (String(row['日付'] || '').startsWith(yyyymm)) consolidated_rows.push(row);
      }
    } catch { /* skip */ }
  }
  consolidated_rows.sort((a, b) => String(a['日付'] || '').localeCompare(String(b['日付'] || '')));

  const by_account = {};
  let exp_total = 0;
  let needs_review_count = 0;
  let unregistered_count = 0;
  for (const row of consolidated_rows) {
    const amount  = parseInt(String(row['金額'] || '0').replace(/[¥,\s]/g, ''), 10) || 0;
    const account = String(row['勘定科目'] || '').trim();
    exp_total += amount;
    by_account[account] = (by_account[account] || 0) + amount;
    if (String(row['要確認']     || '').trim() === '要確認') needs_review_count++;
    const inv = String(row['インボイス対応'] || '').trim();
    if (inv === '不明' || inv === '非対応') unregistered_count++;
  }

  // --- 3. 消込 ---
  const proposals_csvs = safeReadDir(RECONCILE_DIR)
    .filter(f => f.includes(yyyymm) && f.endsWith('.proposals.csv'))
    .map(f => path.resolve(RECONCILE_DIR, f));

  let reconciled_matches = [];
  try {
    const data = JSON.parse(fs.readFileSync(RECONCILED_FILE, 'utf8'));
    reconciled_matches = (data.matches || []).filter(m =>
      String(m.matched_at || '').startsWith(yyyymm)
    );
  } catch { /* empty */ }

  // --- 4. 銀行 CSV (ファイル名に yyyymm を含む) ---
  const bank_csvs = safeReadDir(BANK_DIR)
    .filter(f => f.endsWith('.csv') && !f.startsWith('.') && f.includes(yyyymm))
    .map(f => path.resolve(BANK_DIR, f));

  // --- 5. 領収書 ---
  const receipts = safeReadDir(RECEIPTS_DIR)
    .filter(f => !f.startsWith('.'))
    .map(f => path.resolve(RECEIPTS_DIR, f));

  // --- 6. 月次レポート ---
  const monthly_report = fs.existsSync(REPORT_PATH) ? REPORT_PATH : null;

  // --- 7. 支払済み payables ---
  const paid_payables = [];
  for (const file of safeReadDir(PAYABLES_DIR).filter(f => f.endsWith('.md') && f !== 'README.md')) {
    try {
      const { data: fm } = matter(fs.readFileSync(path.resolve(PAYABLES_DIR, file), 'utf8'));
      if (fm.paid !== true) continue;
      const paidAt = toDateStr(fm.paid_at);
      if (!paidAt.startsWith(yyyymm)) continue;
      paid_payables.push({
        paid_at:        paidAt,
        vendor_name:    String(fm.vendor_name    || '').trim(),
        invoice_number: String(fm.invoice_number || '').trim(),
        amount:         Number(fm.amount)         || 0,
        category:       String(fm.category        || '').trim(),
        note:           String(fm.note            || '').trim(),
      });
    } catch { /* skip */ }
  }

  return {
    yyyymm,
    sales: { invoices, total_billed, total_subtotal, total_tax, total_withholding, count: invoices.length },
    expenses: { entries_csvs, consolidated_rows, by_account, total: exp_total, needs_review_count, unregistered_count },
    reconcile: { proposals_csvs, reconciled_matches },
    bank_csvs,
    receipts,
    monthly_report,
    paid_payables,
  };
}

// ------------------------------------------------------------------ CSV builders

/** 複数 entries.csv を 1 ファイルに集約。日付昇順。 */
function consolidatedExpensesCsv(rows, destPath) {
  const COLS = [
    '日付', '摘要', '金額', '勘定科目', '信頼度', '要確認', '取引先',
    '適格請求書発行事業者番号', 'インボイス対応', '理由',
  ];
  const normalized = rows.map(row => {
    const r = {};
    for (const col of COLS) r[col] = row[col] ?? '';
    return r;
  });
  writeCSV(normalized, destPath);
}

/** 請求書 meta.json 群を 1 CSV に集約。発行日昇順。 */
function consolidatedInvoicesCsv(invoices, destPath) {
  const rows = invoices
    .map(({ meta: m }) => ({
      '請求書番号': m.invoice_number   || '',
      '発行日':     m.issue_date        || '',
      '支払期日':   m.due_date          || '',
      '顧客名':     m.client_name       || '',
      '案件名':     m.project_name      || '',
      '税抜合計':   m.subtotal          ?? 0,
      '消費税':     m.tax_total         ?? 0,
      '源泉徴収':   m.withholding       ?? 0,
      '税込合計':   m.grand_total       ?? 0,
      '差引請求額': m.billed_amount     ?? 0,
      '登録番号':   m.registration_number || '',
      '課税区分':   m.tax_status        || '',
    }))
    .sort((a, b) => a['発行日'].localeCompare(b['発行日']));
  writeCSV(rows, destPath);
}

/** 勘定科目別集計 CSV を生成。 */
function byAccountCsv(by_account, destPath) {
  const rows = Object.entries(by_account)
    .sort((a, b) => b[1] - a[1])
    .map(([acct, total]) => ({ '勘定科目': acct, '合計金額': total }));
  writeCSV(rows, destPath);
}

/** 消込確定一覧 CSV を生成。 */
function matchesCsv(matches, invoiceMap, destPath) {
  const rows = matches.map(m => {
    const inv = invoiceMap.get(m.invoice_number) || {};
    return {
      '消込日':     String(m.matched_at || '').slice(0, 10),
      '請求書番号': m.invoice_number  || '',
      '顧客名':     inv.client_name   || '',
      '入金額':     m.matched_amount  ?? 0,
      '方法':       m.method          || '',
      '備考':       m.note            || '',
    };
  });
  writeCSV(rows, destPath);
}

/** 支払実績 CSV を生成。 */
function paidPayablesCsv(paid_payables, destPath) {
  const rows = paid_payables.map(p => ({
    '支払日':     p.paid_at         || '',
    '取引先':     p.vendor_name     || '',
    '請求書番号': p.invoice_number  || '',
    '金額':       p.amount          || 0,
    'カテゴリ':   p.category        || '',
    '備考':       p.note            || '',
  }));
  writeCSV(rows, destPath);
}

module.exports = {
  collectForMonth,
  consolidatedExpensesCsv,
  consolidatedInvoicesCsv,
  byAccountCsv,
  matchesCsv,
  paidPayablesCsv,
};
