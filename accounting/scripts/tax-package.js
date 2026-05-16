'use strict';
const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { formatJPY }               = require('../lib/money');
const { loadAllInvoices }         = require('../lib/invoice-index');
const { createZip }               = require('../lib/zip');
const {
  collectForMonth,
  consolidatedExpensesCsv,
  consolidatedInvoicesCsv,
  byAccountCsv,
  matchesCsv,
  paidPayablesCsv,
} = require('../lib/tax-package');

const ACC_ROOT    = path.resolve(__dirname, '..');
const PKG_ROOT    = path.resolve(ACC_ROOT, 'outputs/tax-packages');

// ------------------------------------------------------------------ JST helpers

function toJSTISOString() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}
function todayJST() { return toJSTISOString().slice(0, 10); }
function tsLabel()  {
  const s = toJSTISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
}

// ------------------------------------------------------------------ CLI

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { yyyymm: null, zip: false, accountantEmail: null, dryRun: false };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--zip')              opts.zip = true;
    else if (a === '--dry-run')     opts.dryRun = true;
    else if (a === '--accountant-email') opts.accountantEmail = args[++i];
    else if (/^\d{4}-\d{2}$/.test(a))  opts.yyyymm = a;
    i++;
  }
  if (!opts.accountantEmail) {
    opts.accountantEmail = process.env.TAX_ACCOUNTANT_EMAIL || '[税理士のメールアドレス]';
  }
  return opts;
}

// ------------------------------------------------------------------ helpers

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function copyFile(src, destDir) {
  const dest = path.resolve(destDir, path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
}

// 月次レポート MD から売上(税抜)の金額を正規表現で抽出
function extractSalesFromReport(reportPath) {
  try {
    const md = fs.readFileSync(reportPath, 'utf8');
    // "| 売上(税抜)..." の行から ¥X,XXX を拾う
    const m = md.match(/\|\s*売上\(税抜\)[^|]*\|\s*(¥[\d,]+)\s*\|/);
    if (m) return parseInt(m[1].replace(/[¥,]/g, ''), 10);
  } catch { /* */ }
  return null;
}

function extractExpensesFromReport(reportPath) {
  try {
    const md = fs.readFileSync(reportPath, 'utf8');
    const m = md.match(/\|\s*経費合計\(税込\)\s*\|\s*(¥[\d,]+)\s*\|/);
    if (m) return parseInt(m[1].replace(/[¥,]/g, ''), 10);
  } catch { /* */ }
  return null;
}

// ------------------------------------------------------------------ Markdown builders

function buildChecklistMd(data, yyyymm, outDir) {
  const { sales, expenses, reconcile, bank_csvs, receipts, monthly_report, paid_payables } = data;

  // 整合性チェック
  const jiKashi = sales; // placeholder
  const reportSales = monthly_report ? extractSalesFromReport(monthly_report) : null;
  const reportExp   = monthly_report ? extractExpensesFromReport(monthly_report) : null;
  const ji = expenses.by_account['事業主貸'] || 0;
  const businessExp = expenses.total - ji;

  const salesMatch   = reportSales !== null
    ? (reportSales === sales.total_subtotal
        ? '✅ 一致'
        : `⚠️ 差異 ${formatJPY(Math.abs(reportSales - sales.total_subtotal))} (請求書: ${formatJPY(sales.total_subtotal)} / レポート: ${formatJPY(reportSales)})`)
    : '⚠️ 月次レポートが見つかりません';

  const expMatch = reportExp !== null
    ? (reportExp === businessExp
        ? '✅ 一致'
        : `⚠️ 差異 ${formatJPY(Math.abs(reportExp - businessExp))} (経費: ${formatJPY(businessExp)} / レポート: ${formatJPY(reportExp)})`)
    : '⚠️ 月次レポートが見つかりません';

  const allPdfOk = sales.invoices.every(i => i.pdf_path !== null);
  const jiCount  = expenses.consolidated_rows.filter(r => String(r['勘定科目'] || '').trim() === '事業主貸').length;
  const today    = todayJST();

  // 未回収の期日超過請求書
  const allInvoices  = loadAllInvoices();
  const reconciledNums = new Set(
    (() => { try { return JSON.parse(fs.readFileSync(path.resolve(ACC_ROOT, 'state/reconciled.json'), 'utf8')).matches.map(m => m.invoice_number); } catch { return []; } })()
  );
  const overdueUnreceived = allInvoices.filter(inv =>
    !reconciledNums.has(inv.invoice_number) && inv.due_date < today
  );

  const lines = [
    `# 税理士提出パッケージ チェックリスト (${yyyymm})`,
    '',
    '> !! このチェックリストは自動生成された機械チェックです。最終確認は人 / 税理士が行うこと。',
    '',
    '---',
    '',
    '## 必須資料',
    '',
    monthly_report
      ? '- [x] 月次レポート (00-monthly-report.md)'
      : '- [ ] ⚠️ 月次レポートが見つかりません — `npm run monthly-report -- ' + yyyymm + '` を先に実行してください',
    `- [${sales.count > 0 ? 'x' : ' '}] 売上請求書 ${sales.count} 件 (01-invoices/) [${allPdfOk ? '✅ 全件 PDF あり' : '⚠️ 一部 PDF 不足'}]`,
    `- [${expenses.consolidated_rows.length > 0 ? 'x' : ' '}] 経費仕訳 ${expenses.consolidated_rows.length} 件 (02-expenses/_entries-consolidated.csv)`,
    `- [${bank_csvs.length > 0 ? 'x' : ' '}] 銀行明細 ${bank_csvs.length} ファイル (03-bank-statements/)`,
    receipts.length > 0
      ? `- [x] 領収書 ${receipts.length} 件 (06-receipts/)`
      : '- [ ] ⚠️ 領収書 0 件 — inputs/receipts/' + yyyymm + '/ に手動配置が必要',
    '',
    '## 経費の品質',
    '',
    `- 信頼度 < 0.7 の要確認エントリ: **${expenses.needs_review_count} 件**`,
    expenses.needs_review_count > 0
      ? '  → 税理士に渡す前に内容を確認してください'
      : '',
    `- 事業主貸(プライベート支出): ${jiCount} 件 / 合計 ${formatJPY(ji)}`,
    '',
    '## インボイス制度関連',
    '',
    `- 未登録・非対応取引先からの仕入: **${expenses.unregistered_count} 件**`,
    expenses.unregistered_count > 0
      ? '  → 仕入税額控除の経過措置対象の可能性があります'
      : '',
    '',
    '## 整合性チェック',
    '',
    `- 売上請求書合計 vs 月次レポート売上: ${salesMatch}`,
    `- 経費合計 vs 月次レポート経費: ${expMatch}`,
    salesMatch.includes('差異') || expMatch.includes('差異')
      ? '  (差異の主な原因: 源泉徴収控除の扱い / 内税・外税の違い / STEP 間の実行タイミング差)'
      : '',
    '',
    '## 未回収請求書',
    '',
    overdueUnreceived.length > 0
      ? `- ⚠️ 期日超過未回収: ${overdueUnreceived.length} 件 / 合計 ${formatJPY(overdueUnreceived.reduce((s, i) => s + i.billed_amount, 0))}`
      : '- ✅ 期日超過の未回収請求書なし',
    '',
    '## 不足の可能性がある資料',
    '',
    `- 受領した経費領収書(レシート・PDF)を \`06-receipts/\` に追加配置してください`,
    `- 支払予定の振込控え等(必要なら手動で \`05-payments/\` 配下に追加)`,
    '',
    '---',
    `生成日時: ${tsLabel()}`,
  ];

  return lines.filter(l => l !== '').join('\n');
}

function buildEmailMd(data, yyyymm, accountantEmail) {
  const { sales, expenses, reconcile, receipts, paid_payables } = data;
  const ji = expenses.by_account['事業主貸'] || 0;
  const businessExp = expenses.total - ji;
  const grossProfit = sales.total_subtotal - businessExp;

  const today = todayJST();
  const allInvoices = loadAllInvoices();
  const reconciledNums = new Set(
    (() => { try { return JSON.parse(fs.readFileSync(path.resolve(ACC_ROOT, 'state/reconciled.json'), 'utf8')).matches.map(m => m.invoice_number); } catch { return []; } })()
  );
  const overdueCount = allInvoices.filter(inv =>
    !reconciledNums.has(inv.invoice_number) && inv.due_date < today
  ).length;
  const overdueTotal = allInvoices
    .filter(inv => !reconciledNums.has(inv.invoice_number) && inv.due_date < today)
    .reduce((s, i) => s + i.billed_amount, 0);

  const [year, month] = yyyymm.split('-');
  const monthJa = `${year} 年 ${parseInt(month)} 月`;

  return `# 税理士宛メール下書き (${yyyymm})

※ 自動生成された下書きです。送信前に内容を確認してください。

宛先: ${accountantEmail}
件名: 【ICHI】${monthJa}分 月次資料のご送付

──────────────────────────
税理士先生

いつもお世話になっております。
${monthJa}分の月次資料をお送りいたします。

【今月の概況】
- 売上 (税抜):     ${formatJPY(sales.total_subtotal)}
- 経費合計:        ${formatJPY(businessExp)}
- 粗利:            ${formatJPY(grossProfit)}

【同梱資料】
- 月次レポート (00-monthly-report.md)
- 売上請求書一式 ${sales.count} 件 (01-invoices/)
- 経費仕訳 ${expenses.consolidated_rows.length} 件 (02-expenses/)
- 銀行明細 (03-bank-statements/)
- 入金消込確定一覧 (04-reconcile/)
- 支払実績 ${paid_payables.length} 件 (05-payments/)
- 受領領収書 ${receipts.length} 件 (06-receipts/)

【特記事項】
${expenses.needs_review_count > 0
  ? `- 信頼度の低い経費仕訳が ${expenses.needs_review_count} 件あります。02-expenses/ の「要確認」フラグをご確認ください。`
  : '- 要確認の経費仕訳はありません。'}
${expenses.unregistered_count > 0
  ? `- 未登録・非対応取引先からの仕入が ${expenses.unregistered_count} 件あります。インボイス制度の経過措置対象としてご対応をお願いします。`
  : '- インボイス制度関連の特記事項はありません。'}
${overdueCount > 0
  ? `- 期日超過の未回収請求書: ${overdueCount} 件 / 合計 ${formatJPY(overdueTotal)}`
  : ''}

なお、AI による補助計算を含むため、最終的な仕訳・税額確定は
先生のご判断にお任せいたします。
ご不明点ありましたらご連絡ください。

よろしくお願いいたします。

ICHI
──────────────────────────
`;
}

function buildReadmeMd(data, yyyymm) {
  const { sales, expenses, reconcile, bank_csvs, receipts, paid_payables } = data;
  return `# 税理士提出パッケージ ${yyyymm}

このフォルダは \`accounting/scripts/tax-package.js\` により自動生成されました。

## 使い方

1. \`checklist.md\` を確認し、不足資料を補ってください
2. \`accountant-email.md\` の本文をコピーし、税理士にメール送付
3. このフォルダ全体(または ZIP)を添付して送信

## 同梱ファイル一覧

| フォルダ/ファイル | 内容 |
|---|---|
| \`00-monthly-report.md\` | 月次レポート (STEP 6 で生成) |
| \`01-invoices/\` | 売上請求書一式 ${sales.count} 件 (PDF + meta.json + 集約 CSV) |
| \`02-expenses/\` | 経費仕訳 ${expenses.consolidated_rows.length} 件 (集約 CSV + 元ソース) |
| \`03-bank-statements/\` | 銀行明細 CSV ${bank_csvs.length} ファイル |
| \`04-reconcile/\` | 入金消込確定一覧 + 消込提案 CSV |
| \`05-payments/\` | 支払実績 CSV |
| \`06-receipts/\` | 受領領収書 ${receipts.length} 件 |
| \`checklist.md\` | 提出前チェックリスト |
| \`accountant-email.md\` | 税理士宛メール下書き |

## 注意

- AI 補助による出力です。最終確認は人 / 税理士が行うこと
- 推定納税額は概算(各種控除未考慮)です
- インボイス制度の経過措置については税理士にご相談ください
- このフォルダは gitignore で管理対象外です

---
生成日時: ${tsLabel()}
生成元: accounting/scripts/tax-package.js
`;
}

// ------------------------------------------------------------------ main

async function main() {
  const opts = parseArgs();

  if (!opts.yyyymm) {
    process.stderr.write('使い方: node accounting/scripts/tax-package.js <yyyymm> [--zip] [--accountant-email <addr>] [--dry-run]\n');
    process.exit(1);
  }

  const { yyyymm, zip, accountantEmail, dryRun } = opts;

  console.log(`税理士パッケージ生成: ${yyyymm}`);
  const data = collectForMonth(yyyymm);

  // dry-run: 集約予定一覧を表示して終了
  if (dryRun) {
    console.log('\n[DRY RUN] 集約予定:');
    console.log(`  売上請求書:  ${data.sales.count} 件 (total_billed ${formatJPY(data.sales.total_billed)})`);
    console.log(`  経費エントリ: ${data.expenses.consolidated_rows.length} 件 (total ${formatJPY(data.expenses.total)})`);
    console.log(`  銀行 CSV:    ${data.bank_csvs.length} ファイル`);
    console.log(`  領収書:      ${data.receipts.length} 件`);
    console.log(`  月次レポート: ${data.monthly_report ? '✓ あり' : '⚠️ なし'}`);
    console.log(`  消込確定:    ${data.reconcile.reconciled_matches.length} 件`);
    console.log(`  支払実績:    ${data.paid_payables.length} 件`);
    console.log('\n[DRY RUN] ファイルは何も作成しません。');
    return;
  }

  // 出力ディレクトリ
  const outDir = path.resolve(PKG_ROOT, yyyymm);
  ensureDir(outDir);

  // 全請求書マップ(消込確定の顧客名結合用)
  const allInvoicesMap = new Map(loadAllInvoices().map(inv => [inv.invoice_number, inv]));

  // --- 00: 月次レポート ---
  if (data.monthly_report) {
    fs.copyFileSync(data.monthly_report, path.resolve(outDir, '00-monthly-report.md'));
  } else {
    fs.writeFileSync(path.resolve(outDir, '00-monthly-report.md'),
      `# 月次レポート ${yyyymm}\n\n⚠️ 月次レポートが見つかりません。\`npm run monthly-report -- ${yyyymm}\` を実行してください。\n`, 'utf8');
  }

  // --- 01: 請求書 ---
  const invDir = path.resolve(outDir, '01-invoices');
  ensureDir(invDir);
  consolidatedInvoicesCsv(data.sales.invoices, path.resolve(invDir, '_invoices.csv'));
  for (const { meta, pdf_path } of data.sales.invoices) {
    const metaSrc = path.resolve(ACC_ROOT, 'outputs/invoices', `${meta.invoice_number}.meta.json`);
    if (fs.existsSync(metaSrc)) fs.copyFileSync(metaSrc, path.resolve(invDir, `${meta.invoice_number}.meta.json`));
    if (pdf_path && fs.existsSync(pdf_path)) fs.copyFileSync(pdf_path, path.resolve(invDir, `${meta.invoice_number}.pdf`));
  }

  // --- 02: 経費 ---
  const expDir    = path.resolve(outDir, '02-expenses');
  const expSrcDir = path.resolve(expDir, 'source-files');
  ensureDir(expDir);
  ensureDir(expSrcDir);
  consolidatedExpensesCsv(data.expenses.consolidated_rows, path.resolve(expDir, '_entries-consolidated.csv'));
  byAccountCsv(data.expenses.by_account, path.resolve(expDir, '_by-account.csv'));
  for (const fp of data.expenses.entries_csvs) {
    fs.copyFileSync(fp, path.resolve(expSrcDir, path.basename(fp)));
  }

  // --- 03: 銀行明細 ---
  const bankDir = path.resolve(outDir, '03-bank-statements');
  ensureDir(bankDir);
  for (const fp of data.bank_csvs) {
    fs.copyFileSync(fp, path.resolve(bankDir, path.basename(fp)));
  }

  // --- 04: 消込 ---
  const recDir     = path.resolve(outDir, '04-reconcile');
  const propDir    = path.resolve(recDir, 'proposals');
  ensureDir(propDir);
  matchesCsv(data.reconcile.reconciled_matches, allInvoicesMap, path.resolve(recDir, '_matches.csv'));
  for (const fp of data.reconcile.proposals_csvs) {
    fs.copyFileSync(fp, path.resolve(propDir, path.basename(fp)));
  }

  // --- 05: 支払 ---
  const payDir = path.resolve(outDir, '05-payments');
  ensureDir(payDir);
  paidPayablesCsv(data.paid_payables, path.resolve(payDir, '_paid-payables.csv'));

  // --- 06: 領収書 ---
  const recptDir = path.resolve(outDir, '06-receipts');
  ensureDir(recptDir);
  for (const fp of data.receipts) {
    fs.copyFileSync(fp, path.resolve(recptDir, path.basename(fp)));
  }

  // --- トップレベルファイル ---
  fs.writeFileSync(path.resolve(outDir, 'README.md'),          buildReadmeMd(data, yyyymm),              'utf8');
  fs.writeFileSync(path.resolve(outDir, 'checklist.md'),       buildChecklistMd(data, yyyymm, outDir),   'utf8');
  fs.writeFileSync(path.resolve(outDir, 'accountant-email.md'), buildEmailMd(data, yyyymm, accountantEmail), 'utf8');

  console.log(`\n出力: ${outDir}`);
  console.log(`  請求書 ${data.sales.count} 件 / 経費 ${data.expenses.consolidated_rows.length} 件 / 銀行CSV ${data.bank_csvs.length} / 領収書 ${data.receipts.length} 件`);

  // --- ZIP ---
  if (zip) {
    const zipPath = path.resolve(PKG_ROOT, `${yyyymm}.zip`);
    console.log('\nZIP 圧縮中...');
    const { bytes, fileCount } = await createZip(outDir, zipPath);
    console.log(`ZIP: ${zipPath}`);
    console.log(`  サイズ: ${(bytes / 1024).toFixed(1)} KB / ${fileCount} ファイル`);
  }
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
