import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { mdToPdf } from 'md-to-pdf';
import { callClaude } from '../lib/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SALES_ROOT = resolve(__dirname, '..');
const INPUTS_DIR = resolve(SALES_ROOT, 'inputs/quotes');
const OUTPUTS_DIR = resolve(SALES_ROOT, 'outputs/quotes');
const TEMPLATES_DIR = resolve(__dirname, 'templates');

function yen(n) {
  return `¥${n.toLocaleString('ja-JP')}`;
}

function yyyymmdd() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function todayJa() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

async function getQuoteNumber(date) {
  const files = await readdir(OUTPUTS_DIR).catch(() => []);
  const sameDay = files.filter(f => f.startsWith(date) && f.endsWith('.pdf'));
  const seq = sameDay.length + 1;
  return `Q-${date}-${String(seq).padStart(3, '0')}`;
}

function calcTotals(items, taxRate) {
  const rows = items.map(item => ({
    ...item,
    amount: item.quantity * item.unit_price,
  }));
  const subtotal = rows.reduce((s, r) => s + r.amount, 0);
  const tax = Math.floor(subtotal * taxRate);
  const total = subtotal + tax;
  return { rows, subtotal, tax, total, taxPct: Math.round(taxRate * 100) };
}

function buildDetailTable(rows) {
  const header = `<table>
  <thead>
    <tr>
      <th style="width:45%;text-align:left">項目</th>
      <th style="width:10%">単位</th>
      <th style="width:10%">数量</th>
      <th style="width:17.5%;text-align:right">単価</th>
      <th style="width:17.5%;text-align:right">金額</th>
    </tr>
  </thead>
  <tbody>`;

  const body = rows.map(r => `    <tr>
      <td>${r.name}</td>
      <td class="center">${r.unit}</td>
      <td class="center">${r.quantity}</td>
      <td class="num">${yen(r.unit_price)}</td>
      <td class="num">${yen(r.amount)}</td>
    </tr>`).join('\n');

  return `${header}\n${body}\n  </tbody>\n</table>`;
}

function buildTotalsTable(subtotal, tax, total, taxPct) {
  return `<table class="totals-table">
  <tbody>
    <tr>
      <td class="label">小計</td>
      <td class="amount">${yen(subtotal)}</td>
    </tr>
    <tr>
      <td class="label">消費税（${taxPct}%）</td>
      <td class="amount">${yen(tax)}</td>
    </tr>
    <tr class="grand-total">
      <td class="label">合計（税込）</td>
      <td class="amount">${yen(total)}</td>
    </tr>
  </tbody>
</table>`;
}

async function generateQuote(inputPath) {
  const raw = await readFile(inputPath, 'utf-8');
  const data = parseYaml(raw);

  const { rows, subtotal, tax, total, taxPct } = calcTotals(data.items, data.tax_rate);

  const [notesPromptBase, css] = await Promise.all([
    readFile(resolve(TEMPLATES_DIR, 'notes-prompt.md'), 'utf-8'),
    readFile(resolve(TEMPLATES_DIR, 'style.css'), 'utf-8'),
  ]);

  console.log('Claude API 呼び出し中...（備考文生成）');
  const notesText = await callClaude({
    system: notesPromptBase,
    user: `備考ヒント: ${data.notes_hint}`,
    maxTokens: 512,
  });

  await mkdir(OUTPUTS_DIR, { recursive: true });
  const date = yyyymmdd();
  const quoteNo = await getQuoteNumber(date);
  const safeCustomer = data.customer.replace(/[\\/:*?"<>|]/g, '_');
  const outputPath = resolve(OUTPUTS_DIR, `${date}_${safeCustomer}.pdf`);

  const markdown = `# 御見積書

<div class="doc-meta">
発行日：${todayJa()}<br>
見積番号：${quoteNo}
</div>

<div class="summary-box">

**宛先**　${data.customer}　${data.contact}<br>
**件　名**　${data.project_title}<br>
**有効期限**　${formatDate(data.valid_until)}<br>
**合計金額（税込）**　<span class="total-amount">${yen(total)}</span>

</div>

## 御見積明細

${buildDetailTable(rows)}

${buildTotalsTable(subtotal, tax, total, taxPct)}

## 備考

<div class="notes">

${notesText.trim()}

</div>

<div class="issuer">

**ICHI**　ひとり AI ファースト事業<br>
担当：[担当者名]　／　E-mail：[email@example.com]　／　Tel：[電話番号]

</div>
`;

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
  await writeFile(outputPath, pdf.content);

  console.log(`出力: ${outputPath}`);
  console.log(`  小計: ${yen(subtotal)}`);
  console.log(`  消費税（${taxPct}%）: ${yen(tax)}`);
  console.log(`  合計（税込）: ${yen(total)}`);
  return outputPath;
}

async function main() {
  const files = (await readdir(INPUTS_DIR)).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  if (files.length === 0) {
    console.error('入力ファイルが見つかりません:', INPUTS_DIR);
    process.exit(1);
  }
  for (const file of files) {
    console.log(`\n処理開始: ${file}`);
    await generateQuote(resolve(INPUTS_DIR, file));
  }
  console.log('\n全ファイルの処理が完了しました。');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
