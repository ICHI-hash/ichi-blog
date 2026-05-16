'use strict';
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { mdToPdf } = require('md-to-pdf');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const {
  calcConsumptionTax,
  calcWithholding,
  sumAmounts,
  formatJPY,
  assertReconcile,
} = require('../lib/money');
const { issueNext } = require('../lib/invoice-counter');

const ACC_ROOT   = path.resolve(__dirname, '..');
const OUTPUTS_DIR = path.resolve(ACC_ROOT, 'outputs/invoices');
const TEMPLATES_DIR = path.resolve(__dirname, 'templates');

// ------------------------------------------------------------------ helpers

const pad = n => String(n).padStart(2, '0');

// Date オブジェクトまたは YAML 日付文字列を "YYYY-MM-DD" に正規化
function toDateStr(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

// "YYYY-MM-DD" → "YYYY年M月D日"(タイムゾーン非依存)
function formatDateJa(dateStr) {
  const s = toDateStr(dateStr);
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

function todayJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function toJSTISOString() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

function tsLabel() {
  const s = toJSTISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
}

// ------------------------------------------------------------------ CLI

function parseArgs() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let withholding = false;
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--withholding') withholding = true;
    else if (arg === '--dry-run')  dryRun = true;
    else if (!arg.startsWith('--')) inputPath = arg;
  }
  return { inputPath, withholding, dryRun };
}

// ------------------------------------------------------------------ validation

function validate(fm) {
  const errors = [];
  if (!fm.client_name)  errors.push('client_name: 必須フィールドが未設定です');
  if (!fm.project_name) errors.push('project_name: 必須フィールドが未設定です');
  if (!fm.due_date)     errors.push('due_date: 必須フィールドが未設定です');
  if (!Array.isArray(fm.items) || fm.items.length === 0) {
    errors.push('items: 必須フィールドが未設定、または空の配列です');
  } else {
    fm.items.forEach((item, i) => {
      if (!Number.isInteger(item.qty) || item.qty <= 0)
        errors.push(`items[${i}].qty: 正の整数が必要です (値: ${item.qty})`);
      if (!Number.isInteger(item.unit_price) || item.unit_price < 0)
        errors.push(`items[${i}].unit_price: 0 以上の整数が必要です (値: ${item.unit_price})`);
      if (![8, 10].includes(item.tax_rate))
        errors.push(`items[${i}].tax_rate: 8 または 10 が必要です (値: ${item.tax_rate})`);
    });
  }
  return errors;
}

// ------------------------------------------------------------------ amount calc

function calcAmounts(items, useWithholding, taxStatus) {
  const rows = items.map(item => ({
    ...item,
    line_total: item.qty * item.unit_price,
  }));

  const subtotal = rows.reduce((s, r) => s + r.line_total, 0);

  if (taxStatus === 'tax_exempt') {
    return { rows, subtotal, taxBreakdown: {}, taxTotal: 0, grandTotal: subtotal, withholdingAmount: 0, billedAmount: subtotal };
  }

  // 税率ごとに消費税計算
  const taxBreakdown = {};
  for (const row of rows) {
    const rate = row.tax_rate;
    taxBreakdown[rate] = (taxBreakdown[rate] || 0) + calcConsumptionTax(row.line_total, rate);
  }
  const taxTotal = Object.values(taxBreakdown).reduce((s, t) => s + t, 0);
  const grandTotal = subtotal + taxTotal;

  const withholdingAmount = useWithholding ? calcWithholding(subtotal) : 0;
  const billedAmount = grandTotal - withholdingAmount;

  // 検算: 税抜合計 + 消費税合計 - 源泉 = 差引請求額
  assertReconcile(
    [{ amount: subtotal }, { amount: taxTotal }, { amount: -withholdingAmount }],
    billedAmount
  );

  return { rows, subtotal, taxBreakdown, taxTotal, grandTotal, withholdingAmount, billedAmount };
}

// ------------------------------------------------------------------ HTML builders

function buildItemsTable(rows) {
  const body = rows.map(r => `    <tr>
      <td>${r.name}</td>
      <td class="center">${r.qty}</td>
      <td class="num">${formatJPY(r.unit_price)}</td>
      <td class="center">${r.tax_rate}%</td>
      <td class="num">${formatJPY(r.line_total)}</td>
    </tr>`).join('\n');

  return `<table>
  <thead>
    <tr>
      <th style="width:45%;text-align:left">品目</th>
      <th style="width:8%">数量</th>
      <th style="width:17%;text-align:right">単価</th>
      <th style="width:8%">税率</th>
      <th style="width:17%;text-align:right">金額</th>
    </tr>
  </thead>
  <tbody>
${body}
  </tbody>
</table>`;
}

function buildTotalsTable(amounts, taxStatus) {
  const { subtotal, taxBreakdown, taxTotal, grandTotal, withholdingAmount, billedAmount } = amounts;

  if (taxStatus === 'tax_exempt') {
    return `<table class="totals-table">
  <tbody>
    <tr class="grand-total">
      <td class="label">合計</td>
      <td class="amount">${formatJPY(subtotal)}</td>
    </tr>
  </tbody>
</table>`;
  }

  const rows = [];
  rows.push(`    <tr>
      <td class="label">税抜合計</td>
      <td class="amount">${formatJPY(subtotal)}</td>
    </tr>`);

  if ((taxBreakdown[10] || 0) > 0) {
    rows.push(`    <tr>
      <td class="label">消費税（10%）</td>
      <td class="amount">${formatJPY(taxBreakdown[10])}</td>
    </tr>`);
  }
  if ((taxBreakdown[8] || 0) > 0) {
    rows.push(`    <tr>
      <td class="label">消費税（8%・軽減税率）</td>
      <td class="amount">${formatJPY(taxBreakdown[8])}</td>
    </tr>`);
  }

  rows.push(`    <tr class="grand-total">
      <td class="label">税込合計</td>
      <td class="amount">${formatJPY(grandTotal)}</td>
    </tr>`);

  if (withholdingAmount > 0) {
    rows.push(`    <tr>
      <td class="label">源泉徴収税額（控除）</td>
      <td class="amount">−${formatJPY(withholdingAmount)}</td>
    </tr>`);
    rows.push(`    <tr class="grand-total">
      <td class="label">差引請求額</td>
      <td class="amount">${formatJPY(billedAmount)}</td>
    </tr>`);
  }

  return `<table class="totals-table">
  <tbody>
${rows.join('\n')}
  </tbody>
</table>`;
}

// ------------------------------------------------------------------ Markdown builder

function buildMarkdown({ fm, body, amounts, invoiceNumber, issueDate, bizInfo, taxStatus }) {
  const { subtotal, taxBreakdown, taxTotal, grandTotal, withholdingAmount, billedAmount } = amounts;

  const honorific = fm.client_honorific || '御中';
  const issueDateStr = formatDateJa(issueDate);
  const dueDateStr   = formatDateJa(fm.due_date);

  // ご請求金額: 免税なら税抜合計、それ以外は差引請求額(源泉 0 なら = 税込合計)
  const displayAmount = taxStatus === 'tax_exempt' ? subtotal : billedAmount;

  // 登録番号 or 免税事業者注記
  const regLine = (taxStatus === 'tax_exempt' || !bizInfo.INVOICE_REGISTRATION_NUMBER)
    ? '※当事業者は適格請求書発行事業者ではありません'
    : `登録番号：${bizInfo.INVOICE_REGISTRATION_NUMBER}`;

  // クライアント住所の改行を <br> に
  const clientAddr = String(fm.client_address || '').trim().replace(/\n/g, '<br>');

  // 発行者ブロック HTML
  const issuerLines = [
    `<strong>${bizInfo.BUSINESS_NAME || '（BUSINESS_NAME 未設定）'}</strong>`,
    bizInfo.BUSINESS_ADDRESS || '',
    bizInfo.BUSINESS_PHONE ? `TEL：${bizInfo.BUSINESS_PHONE}` : null,
    bizInfo.BUSINESS_BANK_ACCOUNT ? `振込先：${bizInfo.BUSINESS_BANK_ACCOUNT}` : null,
    regLine,
  ].filter(Boolean).join('<br>');

  const parts = [];

  parts.push('# 請求書', '');

  parts.push(`<div class="doc-meta">
請求書番号：${invoiceNumber}<br>
発行日：${issueDateStr}
</div>`, '');

  // 宛先 + 発行者の 2 カラムヘッダ
  parts.push(`<table class="header-table">
<tr>
<td class="header-recipient">
<strong>${fm.client_name}　${honorific}</strong><br>
${clientAddr}<br>
<br>
件名：${fm.project_name}
</td>
<td class="header-issuer">
${issuerLines}
</td>
</tr>
</table>`, '');

  // ご請求金額ボックス
  const paymentLine = [
    `支払期日：${dueDateStr}`,
    fm.payment_terms ? fm.payment_terms : null,
  ].filter(Boolean).join('　／　');

  parts.push(`<div class="summary-box">

**ご請求金額**　<span class="total-amount">${formatJPY(displayAmount)}</span>

${paymentLine}

</div>`, '');

  // 明細
  parts.push('## ご請求明細', '');
  parts.push(buildItemsTable(amounts.rows), '');
  parts.push(buildTotalsTable(amounts, taxStatus), '');

  // 備考
  if (fm.notes) {
    parts.push('## 備考', '');
    parts.push(`<div class="notes">

${String(fm.notes).trim()}

</div>`, '');
  }

  // 本文補足
  if (body && body.trim()) {
    parts.push('## 補足', '');
    parts.push(body.trim(), '');
  }

  // フッタ
  const footerLines = [];
  if (taxStatus !== 'tax_exempt' && bizInfo.INVOICE_REGISTRATION_NUMBER) {
    footerLines.push('本書は適格請求書として発行しております。');
  }
  footerLines.push(`生成日時：${tsLabel()}`);
  footerLines.push('⚠️ AI 補助による出力。最終確認は人が行うこと。');

  parts.push(`<div class="footer-note">
${footerLines.join('<br>')}
</div>`);

  return parts.join('\n');
}

// ------------------------------------------------------------------ main

async function main() {
  const { inputPath, withholding, dryRun } = parseArgs();

  if (!inputPath) {
    console.error('使い方: node accounting/scripts/invoice.js <入力Markdownパス> [--withholding] [--dry-run]');
    process.exit(1);
  }

  const absPath = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(absPath)) {
    console.error(`ファイルが見つかりません: ${absPath}`);
    process.exit(1);
  }

  // frontmatter パース
  const raw = fs.readFileSync(absPath, 'utf8');
  const { data: fm, content: body } = matter(raw);

  // バリデーション
  const errors = validate(fm);
  if (errors.length > 0) {
    errors.forEach(e => process.stderr.write(`[ERROR] ${e}\n`));
    process.exit(1);
  }

  // 事業者情報(.env から)
  const bizInfo = {
    BUSINESS_NAME:               process.env.BUSINESS_NAME               || '',
    BUSINESS_ADDRESS:            process.env.BUSINESS_ADDRESS            || '',
    BUSINESS_PHONE:              process.env.BUSINESS_PHONE              || '',
    BUSINESS_BANK_ACCOUNT:       process.env.BUSINESS_BANK_ACCOUNT       || '',
    INVOICE_REGISTRATION_NUMBER: process.env.INVOICE_REGISTRATION_NUMBER || '',
    TAX_STATUS:                  process.env.TAX_STATUS                  || '',
  };

  const taxStatus  = bizInfo.TAX_STATUS === 'tax_exempt' ? 'tax_exempt' : 'taxable';
  const issueDate  = fm.issue_date ? toDateStr(fm.issue_date) : todayJST();

  // 金額計算
  const amounts = calcAmounts(fm.items, withholding, taxStatus);

  // --- dry-run ---
  if (dryRun) {
    console.log('[DRY RUN] 計算結果:');
    console.log(`  税抜合計:       ${formatJPY(amounts.subtotal)}`);
    if (taxStatus !== 'tax_exempt') {
      if ((amounts.taxBreakdown[10] || 0) > 0) console.log(`  消費税(10%):    ${formatJPY(amounts.taxBreakdown[10])}`);
      if ((amounts.taxBreakdown[8]  || 0) > 0) console.log(`  消費税(8%):     ${formatJPY(amounts.taxBreakdown[8])}`);
      console.log(`  税込合計:       ${formatJPY(amounts.grandTotal)}`);
    }
    if (withholding) console.log(`  源泉徴収:       ${formatJPY(amounts.withholdingAmount)}`);
    console.log(`  差引請求額:     ${formatJPY(amounts.billedAmount)}`);
    console.log('');

    const markdown = buildMarkdown({
      fm, body, amounts,
      invoiceNumber: 'INV-XXXX-XXXX',
      issueDate,
      bizInfo,
      taxStatus,
    });
    console.log('[DRY RUN] Markdown プレビュー (先頭 500 文字):');
    console.log(markdown.slice(0, 500));
    return;
  }

  // --- 本番実行 ---
  const { number: invoiceNumber } = issueNext();
  console.log(`請求書番号: ${invoiceNumber}`);

  const markdown = buildMarkdown({ fm, body, amounts, invoiceNumber, issueDate, bizInfo, taxStatus });

  // PDF 生成
  const css = fs.readFileSync(path.resolve(TEMPLATES_DIR, 'style.css'), 'utf8');
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

  const pdfPath  = path.resolve(OUTPUTS_DIR, `${invoiceNumber}.pdf`);
  const metaPath = path.resolve(OUTPUTS_DIR, `${invoiceNumber}.meta.json`);

  console.log('PDF 生成中...');
  const pdf = await mdToPdf(
    { content: markdown },
    {
      css,
      launch_options: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
      pdf_options: {
        format: 'A4',
        margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
        printBackground: true,
      },
    }
  );

  if (!pdf?.content) throw new Error('PDF の生成に失敗しました');
  fs.writeFileSync(pdfPath, pdf.content);
  console.log(`PDF 出力: ${pdfPath}`);

  // meta.json
  const meta = {
    _warning: 'AI 補助による出力。最終確認は人が行うこと',
    invoice_number: invoiceNumber,
    issue_date: issueDate,
    due_date: toDateStr(fm.due_date),
    client_name: fm.client_name,
    project_name: fm.project_name,
    subtotal: amounts.subtotal,
    tax_breakdown: amounts.taxBreakdown,
    tax_total: amounts.taxTotal,
    withholding: amounts.withholdingAmount,
    grand_total: amounts.grandTotal,
    billed_amount: amounts.billedAmount,
    currency: 'JPY',
    items: fm.items.map(({ name, qty, unit_price, tax_rate }) => ({ name, qty, unit_price, tax_rate })),
    registration_number: bizInfo.INVOICE_REGISTRATION_NUMBER || null,
    tax_status: taxStatus,
    generated_at: toJSTISOString(),
  };

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(`メタ出力: ${metaPath}`);
  console.log('');
  console.log(`  税抜合計:   ${formatJPY(amounts.subtotal)}`);
  if (taxStatus !== 'tax_exempt') {
    if ((amounts.taxBreakdown[10] || 0) > 0) console.log(`  消費税(10%): ${formatJPY(amounts.taxBreakdown[10])}`);
    if ((amounts.taxBreakdown[8]  || 0) > 0) console.log(`  消費税(8%):  ${formatJPY(amounts.taxBreakdown[8])}`);
    console.log(`  税込合計:   ${formatJPY(amounts.grandTotal)}`);
  }
  if (withholding) console.log(`  源泉徴収:   ${formatJPY(amounts.withholdingAmount)}`);
  console.log(`  差引請求額: ${formatJPY(amounts.billedAmount)}`);
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
