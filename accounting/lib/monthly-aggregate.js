'use strict';
const fs   = require('fs');
const path = require('path');
const matter = require('gray-matter');

const { parseCSV }        = require('./csv');
const { loadAllInvoices } = require('./invoice-index');

const ACC_ROOT       = path.resolve(__dirname, '..');
const INVOICES_DIR   = path.resolve(ACC_ROOT, 'outputs/invoices');
const CATEGORIZE_DIR = path.resolve(ACC_ROOT, 'outputs/categorize');
const PAYABLES_DIR   = path.resolve(ACC_ROOT, 'inputs/payables');
const RECONCILED_FILE = path.resolve(ACC_ROOT, 'state/reconciled.json');

// 消費税逆算で除外する科目(税額計算に適さないもの)
const TAX_CREDIT_EXCLUDE = new Set(['事業主貸', '租税公課']);

function toDateStr(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

// ------------------------------------------------------------------ invoices

/**
 * 指定月 (yyyymm = "2026-05") に発行された請求書を集約する。
 * 副作用なし・冪等。
 */
function collectInvoicesForMonth(yyyymm) {
  const allInvoices = loadAllInvoices();
  const invoices = allInvoices.filter(inv => String(inv.issue_date || '').startsWith(yyyymm));

  let total_billed     = 0;
  let total_subtotal   = 0;
  let total_tax        = 0;
  let total_withholding = 0;
  const by_client  = {};
  const by_project = {};

  for (const inv of invoices) {
    total_billed      += inv.billed_amount  || 0;
    total_subtotal    += inv.subtotal       || 0;
    total_tax         += inv.tax_total      || 0;
    total_withholding += inv.withholding    || 0;

    const cn = inv.client_name  || '不明';
    const pn = inv.project_name || '不明';
    by_client[cn]  = (by_client[cn]  || 0) + (inv.billed_amount || 0);
    by_project[pn] = (by_project[pn] || 0) + (inv.billed_amount || 0);
  }

  return { invoices, total_billed, total_subtotal, total_tax, total_withholding, by_client, by_project };
}

// ------------------------------------------------------------------ expenses

/**
 * 指定月の経費仕訳エントリを全 entries.csv から集約する。
 * 副作用なし・冪等。
 * entries.csv の金額は税込整数。消費税は内税前提で逆算(概算・誤差あり)。
 */
function collectExpensesForMonth(yyyymm) {
  let files = [];
  try {
    files = fs.readdirSync(CATEGORIZE_DIR).filter(f => f.endsWith('.entries.csv'));
  } catch {
    return { entries: [], total: 0, by_account: {}, needs_review_count: 0, tax_credit_estimate: 0 };
  }

  const entries = [];
  for (const file of files) {
    const filepath = path.resolve(CATEGORIZE_DIR, file);
    try {
      const rows = parseCSV(filepath, { columns: true });
      for (const row of rows) {
        const date = String(row['日付'] || '').trim();
        if (!date.startsWith(yyyymm)) continue;
        const rawAmt = String(row['金額'] || '0').replace(/[¥,\s]/g, '');
        const amount = parseInt(rawAmt, 10);
        if (isNaN(amount) || amount <= 0) continue;
        entries.push({
          date,
          description:  String(row['摘要']    || '').trim(),
          amount,
          account:      String(row['勘定科目'] || '').trim(),
          confidence:   parseFloat(String(row['信頼度'] || '0')) || 0,
          needs_review: String(row['要確認'] || '').trim() === '要確認',
          vendor:       String(row['取引先'] || '').trim(),
        });
      }
    } catch (err) {
      process.stderr.write(`[warn] entries.csv 読み込み失敗 (${file}): ${err.message}\n`);
    }
  }

  let total = 0;
  let needs_review_count = 0;
  let tax_credit_estimate = 0;
  const by_account = {};

  for (const e of entries) {
    total += e.amount;
    by_account[e.account] = (by_account[e.account] || 0) + e.amount;
    if (e.needs_review) needs_review_count++;
    // 消費税逆算(内税前提): 除外科目以外に 10% 内税を仮定
    if (!TAX_CREDIT_EXCLUDE.has(e.account)) {
      // floor(amount * 10 / 11) = 税抜額
      const excl = Math.floor(e.amount * 10 / 11);
      tax_credit_estimate += e.amount - excl;
    }
  }

  return { entries, total, by_account, needs_review_count, tax_credit_estimate };
}

// ------------------------------------------------------------------ payments (paid payables)

/**
 * 指定月に paid=true になった payables を集約する。
 * paid_at が yyyymm に含まれるもの。副作用なし・冪等。
 */
function collectPaymentsForMonth(yyyymm) {
  let files = [];
  try {
    files = fs.readdirSync(PAYABLES_DIR)
      .filter(f => f.endsWith('.md') && f !== '.gitkeep' && f !== 'README.md');
  } catch {
    return { paid_count: 0, paid_total: 0, by_category: {}, items: [] };
  }

  const items = [];
  for (const file of files) {
    const filepath = path.resolve(PAYABLES_DIR, file);
    try {
      const { data: fm } = matter(fs.readFileSync(filepath, 'utf8'));
      if (fm.paid !== true) continue;
      const paidAt = toDateStr(fm.paid_at);
      if (!paidAt.startsWith(yyyymm)) continue;
      items.push({
        paid_at:        paidAt,
        vendor_name:    String(fm.vendor_name    || '').trim(),
        invoice_number: String(fm.invoice_number || '').trim(),
        amount:         Number(fm.amount)         || 0,
        category:       String(fm.category        || '').trim(),
        note:           String(fm.note            || '').trim(),
      });
    } catch {
      // skip
    }
  }

  const paid_total = items.reduce((s, p) => s + p.amount, 0);
  const by_category = {};
  for (const p of items) {
    const cat = p.category || '未分類';
    by_category[cat] = (by_category[cat] || 0) + p.amount;
  }

  return { paid_count: items.length, paid_total, by_category, items };
}

// ------------------------------------------------------------------ receipts (reconciled)

/**
 * 指定月に消込された入金実績を reconciled.json から集約する。
 * 副作用なし・冪等。
 */
function collectReceiptsForMonth(yyyymm) {
  let reconciledData = { matches: [] };
  try {
    reconciledData = JSON.parse(fs.readFileSync(RECONCILED_FILE, 'utf8'));
  } catch {
    return { match_count: 0, received_total: 0, items: [] };
  }

  // invoice の詳細情報を結合するためのマップを作成
  const allInvoices = loadAllInvoices();
  const invMap = new Map(allInvoices.map(inv => [inv.invoice_number, inv]));

  const items = [];
  for (const m of (reconciledData.matches || [])) {
    // matched_at が yyyymm 月内のもの
    if (!String(m.matched_at || '').startsWith(yyyymm)) continue;
    const inv = invMap.get(m.invoice_number) || {};
    items.push({
      matched_at:     m.matched_at,
      invoice_number: m.invoice_number,
      client_name:    inv.client_name  || '不明',
      matched_amount: m.matched_amount || 0,
      method:         m.method         || '',
    });
  }

  const received_total = items.reduce((s, i) => s + i.matched_amount, 0);
  return { match_count: items.length, received_total, items };
}

module.exports = {
  collectInvoicesForMonth,
  collectExpensesForMonth,
  collectPaymentsForMonth,
  collectReceiptsForMonth,
};
