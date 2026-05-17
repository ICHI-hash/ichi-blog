'use strict';
const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { formatJPY }                       = require('../lib/money');
const { estimateMonthlyTax }              = require('../lib/tax-estimate');
const {
  collectInvoicesForMonth,
  collectExpensesForMonth,
  collectPaymentsForMonth,
  collectReceiptsForMonth,
} = require('../lib/monthly-aggregate');
const { createPage, markdownToBlocks }    = require('../lib/notion');

const { pathForOutputs } = require('../../lib/paths.js');
const OUTPUTS_DIR = pathForOutputs('accounting', 'monthly-reports');

// ------------------------------------------------------------------ JST helpers

function toJSTISOString() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}
function tsLabel() {
  const s = toJSTISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
}

// ------------------------------------------------------------------ CLI

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    yyyymm:          null,
    comparePrevMonth: false,
    comparePrevYear:  false,
    notion:           false,
    dryRun:           false,
  };
  for (const a of args) {
    if (a === '--compare-prev-month') opts.comparePrevMonth = true;
    else if (a === '--compare-prev-year')  opts.comparePrevYear  = true;
    else if (a === '--notion')             opts.notion           = true;
    else if (a === '--dry-run')            opts.dryRun           = true;
    else if (/^\d{4}-\d{2}$/.test(a))     opts.yyyymm           = a;
  }
  return opts;
}

// ------------------------------------------------------------------ date utils

function prevMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
function prevYear(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return `${y - 1}-${String(m).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ ratio helper

/** 構成比 % 表示 (浮動小数は表示のみ) */
function pct(num, denom) {
  if (!denom) return '-';
  return `${Math.round((num / denom) * 1000) / 10}%`;
}

/** 前月比 / 前年比 (±XX.X%) */
function changePct(current, prev) {
  if (prev === 0) return current === 0 ? '±0%' : '(前期ゼロ)';
  const diff = Math.round(((current - prev) / Math.abs(prev)) * 1000) / 10;
  return diff >= 0 ? `+${diff}%` : `${diff}%`;
}

// ------------------------------------------------------------------ Markdown builder

function buildReportMd({
  yyyymm, invoices, expenses, receipts, payments, tax,
  prevMonthData, prevYearData,
  taxMethod, taxStatus, businessCategory,
}) {
  const {
    total_subtotal, total_tax, total_billed, total_withholding,
    by_client, by_project,
  } = invoices;
  const { total: expTotal, by_account, needs_review_count, tax_credit_estimate } = expenses;
  // 事業主貸を経費から除外
  const jigyoushiKashi = by_account['事業主貸'] || 0;
  const businessExpenses = expTotal - jigyoushiKashi;

  const grossProfit    = total_subtotal - businessExpenses;
  const unreceivedAmt  = total_billed - receipts.received_total;

  const lines = [];

  // ヘッダ
  lines.push(`# 月次レポート ${yyyymm}`, '');
  lines.push('> ⚠️ **AI 補助による出力。最終確認は人 / 税理士が行うこと。**');
  lines.push('> **推定納税額は概算。確定申告は税理士に依頼してください。**', '');
  lines.push('---', '');

  // サマリ
  lines.push('## サマリ', '');
  const pmp = prevMonthData
    ? ` (前月比 ${changePct(total_subtotal, prevMonthData.invoices.total_subtotal)})`
    : prevMonthData === null ? ' (前月データなし)' : '';
  const pyp = prevYearData
    ? ` (前年同月比 ${changePct(total_subtotal, prevYearData.invoices.total_subtotal)})`
    : prevYearData === null ? ' (前年同月データなし)' : '';

  lines.push(`| 項目 | 金額 |`);
  lines.push(`|---|---|`);
  lines.push(`| 売上(税抜)${pmp}${pyp} | ${formatJPY(total_subtotal)} |`);
  lines.push(`| 売上(税込) | ${formatJPY(total_billed + total_withholding)} |`);
  lines.push(`| 源泉徴収控除 | ${total_withholding > 0 ? formatJPY(total_withholding) : '-'} |`);
  lines.push(`| 経費合計(税込) | ${formatJPY(businessExpenses)} |`);
  lines.push(`| 粗利(税抜売上 - 事業経費) | ${formatJPY(grossProfit)} |`);
  lines.push(`| 入金実績(消込済) | ${formatJPY(receipts.received_total)} |`);
  lines.push(`| 期末未回収(発行済 - 入金) | ${formatJPY(unreceivedAmt)} |`);
  lines.push(`| 推定納税額(月割概算) | ${formatJPY(tax.total_monthly)} |`);
  lines.push(`| 　うち所得税(復興税込) | ${formatJPY(tax.income_tax_monthly)} |`);
  lines.push(`| 　うち住民税 | ${formatJPY(tax.resident_tax_monthly)} |`);
  lines.push(`| 　うち消費税(${taxMethod === 'general' ? '本則' : '簡易'}) | ${formatJPY(tax.consumption_tax_monthly)} |`);
  lines.push('');

  // 案件別売上
  lines.push('## 案件別売上', '');
  const projectEntries = Object.entries(by_project).sort((a, b) => b[1] - a[1]);
  if (projectEntries.length === 0) {
    lines.push('(発行済み請求書なし)');
  } else {
    lines.push('| 案件名 | 顧客名 | 請求額 |');
    lines.push('|---|---|---|');
    for (const inv of invoices.invoices) {
      lines.push(`| ${inv.project_name} | ${inv.client_name} | ${formatJPY(inv.billed_amount)} |`);
    }
  }
  lines.push('');

  // 顧客別売上
  lines.push('## 顧客別売上', '');
  const clientEntries = Object.entries(by_client).sort((a, b) => b[1] - a[1]);
  if (clientEntries.length === 0) {
    lines.push('(発行済み請求書なし)');
  } else {
    lines.push('| 顧客名 | 件数 | 請求合計 |');
    lines.push('|---|---|---|');
    for (const [cn, total] of clientEntries) {
      const cnt = invoices.invoices.filter(inv => inv.client_name === cn).length;
      lines.push(`| ${cn} | ${cnt} | ${formatJPY(total)} |`);
    }
  }
  lines.push('');

  // 経費(勘定科目別)
  lines.push('## 経費(勘定科目別)', '');
  const acctEntries = Object.entries(by_account)
    .filter(([k]) => k !== '事業主貸')
    .sort((a, b) => b[1] - a[1]);
  if (acctEntries.length === 0) {
    lines.push('(経費エントリなし)');
  } else {
    lines.push('| 勘定科目 | 件数 | 合計 | 構成比 |');
    lines.push('|---|---|---|---|');
    for (const [acct, total] of acctEntries) {
      const cnt = expenses.entries.filter(e => e.account === acct).length;
      lines.push(`| ${acct} | ${cnt} | ${formatJPY(total)} | ${pct(total, businessExpenses)} |`);
    }
    if (jigyoushiKashi > 0) {
      lines.push(`| 事業主貸(除外) | ${expenses.entries.filter(e=>e.account==='事業主貸').length} | ${formatJPY(jigyoushiKashi)} | - |`);
    }
  }
  if (needs_review_count > 0) lines.push(`\n※ 信頼度 < 0.7 の要確認エントリ: ${needs_review_count} 件`);
  lines.push('※ 事業主貸(プライベート支出)は経費合計から除外しています');
  lines.push('');

  // 入金実績
  lines.push('## 入金実績(発生主義の売上とは別)', '');
  if (receipts.items.length === 0) {
    lines.push('(消込済み入金なし)');
  } else {
    lines.push('| 消込日 | 請求書番号 | 顧客名 | 入金額 | 方法 |');
    lines.push('|---|---|---|---|---|');
    for (const r of receipts.items) {
      const dateStr = String(r.matched_at || '').slice(0, 10);
      lines.push(`| ${dateStr} | ${r.invoice_number} | ${r.client_name} | ${formatJPY(r.matched_amount)} | ${r.method} |`);
    }
    lines.push(`\n合計: ${formatJPY(receipts.received_total)} (${receipts.match_count} 件)`);
  }
  lines.push('');

  // 支払実績
  lines.push('## 支払実績(paid=true の payables)', '');
  if (payments.items.length === 0) {
    lines.push('(支払完了の payable なし)');
  } else {
    lines.push('| 支払日 | 取引先 | 請求書番号 | 金額 | カテゴリ |');
    lines.push('|---|---|---|---|---|');
    for (const p of payments.items) {
      lines.push(`| ${p.paid_at} | ${p.vendor_name} | ${p.invoice_number} | ${formatJPY(p.amount)} | ${p.category || '-'} |`);
    }
    lines.push(`\n合計: ${formatJPY(payments.paid_total)} (${payments.paid_count} 件)`);
  }
  lines.push('');

  // 推定納税額
  lines.push('## 推定納税額(月割・粗い概算)', '');
  lines.push('| 税目 | 月額概算 | 計算根拠 |');
  lines.push('|---|---|---|');
  lines.push(`| 所得税(復興税込) | ${formatJPY(tax.income_tax_monthly)} | 年換算課税所得 ${formatJPY(tax.annualized_income)} に超過累進を適用 / 12 |`);
  lines.push(`| 住民税(概算) | ${formatJPY(tax.resident_tax_monthly)} | 年換算課税所得 × 10% / 12 (均等割除く) |`);
  lines.push(`| 消費税(${taxMethod === 'general' ? '本則' : '簡易・区分' + businessCategory}) | ${formatJPY(tax.consumption_tax_monthly)} | ${taxMethod === 'general' ? '預かり消費税 - 支払消費税' : 'みなし仕入率適用'} |`);
  lines.push(`| **合計** | **${formatJPY(tax.total_monthly)}** | |`);
  lines.push('');
  lines.push('※ 各種所得控除(基礎控除・青色申告特別控除・社会保険料控除等)は考慮していません。');
  lines.push('　実際の納税額は税理士の最終計算に従ってください。');
  lines.push('');

  // 比較セクション
  if (prevMonthData !== undefined || prevYearData !== undefined) {
    lines.push('## 前月比較 / 前年同月比較', '');
    lines.push('| 指標 | 当月 | 前月 | 前月比 | 前年同月 | 前年比 |');
    lines.push('|---|---|---|---|---|---|');
    const pm = prevMonthData || { invoices: { total_subtotal: 0, total_billed: 0 }, expenses: { total: 0 } };
    const py = prevYearData  || { invoices: { total_subtotal: 0, total_billed: 0 }, expenses: { total: 0 } };
    const pmLabel = prevMonthData  ? formatJPY(pm.invoices.total_subtotal) : '前月データなし';
    const pyLabel = prevYearData   ? formatJPY(py.invoices.total_subtotal) : '前年同月データなし';
    const pmCh = prevMonthData ? changePct(total_subtotal, pm.invoices.total_subtotal) : '-';
    const pyCh = prevYearData  ? changePct(total_subtotal, py.invoices.total_subtotal) : '-';
    lines.push(`| 売上(税抜) | ${formatJPY(total_subtotal)} | ${pmLabel} | ${pmCh} | ${pyLabel} | ${pyCh} |`);

    const pmExpLabel = prevMonthData ? formatJPY(pm.expenses.total - (pm.expenses.by_account?.['事業主貸'] || 0)) : '-';
    const pyExpLabel = prevYearData  ? formatJPY(py.expenses.total - (py.expenses.by_account?.['事業主貸'] || 0)) : '-';
    lines.push(`| 経費合計 | ${formatJPY(businessExpenses)} | ${pmExpLabel} | - | ${pyExpLabel} | - |`);
    lines.push('');
  }

  // 留意事項
  lines.push('## 留意事項', '');
  lines.push('- 売上は発行済み請求書ベース(発生主義)');
  lines.push('- 経費は categorize 出力の税込金額ベース(消費税は内税前提で逆算)');
  lines.push('- 軽減税率(8%)対象の経費が混在する場合、消費税逆算に誤差あり');
  lines.push('- 入金・支払実績はキャッシュフロー把握用(発生主義の売上/経費とは別)');
  lines.push(`- 税率は 2026 年 5 月時点 (TAX_STATUS: ${taxStatus}, TAX_METHOD: ${taxMethod})`);
  lines.push('');
  lines.push('---');
  lines.push(`生成日時: ${tsLabel()}`);
  lines.push('生成元: accounting/scripts/monthly-report.js');

  return lines.join('\n');
}

// ------------------------------------------------------------------ Notion

async function postToNotion(yyyymm, data, markdownContent) {
  const dbId = process.env.NOTION_DB_MONTHLY_REPORT_ID || '';
  if (!process.env.NOTION_TOKEN || !dbId) {
    process.stderr.write('[warn] NOTION_TOKEN または NOTION_DB_MONTHLY_REPORT_ID が未設定。Notion 連携をスキップします。\n');
    return;
  }

  const { invoices, expenses, tax, grossProfit } = data;
  const ji = expenses.by_account?.['事業主貸'] || 0;
  const businessExp = expenses.total - ji;

  const properties = {
    Month:          { title: [{ text: { content: yyyymm } }] },
    Revenue:        { number: invoices.total_subtotal },
    Expenses:       { number: businessExp },
    'Gross Profit': { number: grossProfit },
    'Estimated Tax':{ number: tax.total_monthly },
    'Generated At': { date: { start: toJSTISOString().slice(0, 10) } },
  };

  const children = markdownToBlocks(markdownContent).slice(0, 100);
  const result = await createPage({ databaseId: dbId, properties, children });

  if (result.ok) {
    console.log(`Notion ページ作成成功: ${result.page?.id || ''}`);
  } else {
    process.stderr.write(`[warn] Notion ページ作成失敗: ${result.error}\n`);
  }
}

// ------------------------------------------------------------------ main

async function main() {
  const opts = parseArgs();

  if (!opts.yyyymm) {
    process.stderr.write('使い方: node accounting/scripts/monthly-report.js <yyyymm>\n');
    process.stderr.write('  yyyymm 例: 2026-05\n');
    process.stderr.write('  オプション: --compare-prev-month --compare-prev-year --notion --dry-run\n');
    process.exit(1);
  }

  const { yyyymm, comparePrevMonth, comparePrevYear, notion, dryRun } = opts;

  const taxStatus          = process.env.TAX_STATUS           === 'tax_exempt' ? 'tax_exempt' : 'taxable';
  const taxMethod          = process.env.TAX_METHOD           === 'general'    ? 'general'    : 'simple';
  const businessCategory   = process.env.TAX_BUSINESS_CATEGORY || '5';

  console.log(`月次レポート生成: ${yyyymm}`);
  console.log(`  TAX_STATUS=${taxStatus}  TAX_METHOD=${taxMethod}  BUSINESS_CATEGORY=${businessCategory}`);

  // データ収集
  const invoices  = collectInvoicesForMonth(yyyymm);
  const expenses  = collectExpensesForMonth(yyyymm);
  const receipts  = collectReceiptsForMonth(yyyymm);
  const payments  = collectPaymentsForMonth(yyyymm);

  console.log(`  請求書 ${invoices.invoices.length} 件 / 経費エントリ ${expenses.entries.length} 件 / 消込 ${receipts.match_count} 件 / 支払 ${payments.paid_count} 件`);

  // 事業経費(事業主貸除外)
  const jigyoushiKashi = expenses.by_account['事業主貸'] || 0;
  const businessExpenses = expenses.total - jigyoushiKashi;
  const grossProfit = invoices.total_subtotal - businessExpenses;

  // 推定納税額
  const tax = estimateMonthlyTax({
    monthlyTaxableIncome:       grossProfit,
    monthlyTaxableSalesEx:      invoices.total_subtotal,
    monthlyTaxableSalesTax:     invoices.total_tax,
    monthlyTaxableExpensesTax:  expenses.tax_credit_estimate,
    taxStatus,
    taxMethod,
    businessCategory,
  });

  // 比較データ
  let prevMonthData = undefined;
  let prevYearData  = undefined;

  if (comparePrevMonth) {
    const pm = prevMonth(yyyymm);
    const pmInv = collectInvoicesForMonth(pm);
    const pmExp = collectExpensesForMonth(pm);
    prevMonthData = pmInv.invoices.length === 0 && pmExp.entries.length === 0
      ? null
      : { invoices: pmInv, expenses: pmExp };
    console.log(`  前月 ${pm}: 請求書 ${pmInv.invoices.length} 件 / 経費 ${pmExp.entries.length} 件`);
  }
  if (comparePrevYear) {
    const py = prevYear(yyyymm);
    const pyInv = collectInvoicesForMonth(py);
    const pyExp = collectExpensesForMonth(py);
    prevYearData = pyInv.invoices.length === 0 && pyExp.entries.length === 0
      ? null
      : { invoices: pyInv, expenses: pyExp };
    console.log(`  前年同月 ${py}: 請求書 ${pyInv.invoices.length} 件`);
  }

  // Markdown 生成
  const md = buildReportMd({
    yyyymm, invoices, expenses, receipts, payments, tax,
    prevMonthData, prevYearData,
    taxMethod, taxStatus, businessCategory,
  });

  if (dryRun) {
    console.log('\n[DRY RUN] レポート出力:\n');
    console.log(md);
    return;
  }

  // ファイル出力
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  const outPath = path.resolve(OUTPUTS_DIR, `${yyyymm}.md`);
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`\n出力: ${outPath}`);

  // Notion 連携
  if (notion) {
    await postToNotion(yyyymm, { invoices, expenses, tax, grossProfit }, md);
  }
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
