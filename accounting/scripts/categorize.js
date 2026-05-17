'use strict';
const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { parseTransactionsFromCSV, writeCSV } = require('../lib/csv');
const { runPrompt }      = require('../lib/claude');
const ACCOUNT_CATEGORIES = require('../lib/account-categories');
const {
  computeHash,
  loadProcessed,
  saveProcessed,
  recentSamples,
  loadVendorRegistry,
  lookupVendorRegistration,
} = require('../lib/expense-state');
const { sumAmounts, formatJPY } = require('../lib/money');

const { pathForOutputs } = require('../../lib/paths.js');
const OUTPUTS_DIR = pathForOutputs('accounting', 'categorize');

// ------------------------------------------------------------------ JST helpers

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
  const opts = {
    inputPath:       null,
    format:          null,
    encoding:        'utf8',
    manualMapping:   null,
    checkInvoice:    false,
    batchSize:       20,
    dryRun:          false,
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--format')           { opts.format        = args[++i]; }
    else if (a === '--encoding')    { opts.encoding       = args[++i]; }
    else if (a === '--manual-mapping') { opts.manualMapping = args[++i]; }
    else if (a === '--check-invoice-number') { opts.checkInvoice = true; }
    else if (a === '--batch-size')  { opts.batchSize      = parseInt(args[++i], 10) || 20; }
    else if (a === '--dry-run')     { opts.dryRun         = true; }
    else if (!a.startsWith('--'))   { opts.inputPath      = a; }
    i++;
  }

  return opts;
}

// ------------------------------------------------------------------ prompt builders

function buildCategoryList(categories) {
  return categories.map(c =>
    `- **${c.name}** (${c.code}): ${c.description} 例: ${c.examples}`
  ).join('\n');
}

function buildFewShot(samples) {
  if (samples.length === 0) return '(仕訳例なし)';
  return samples.slice(0, 20).map(s => `- "${s.description}" → ${s.account}`).join('\n');
}

function buildSystemPrompt(categories, samples) {
  return `あなたは日本の個人事業主の経理仕訳を補助する AI です。
以下の勘定科目一覧に沿って、各取引の最も適切な勘定科目を 1 つ選び、
信頼度(0.0〜1.0)と理由を JSON で返してください。

ルール:
- プライベートな支出(食料品店・コンビニの生活費・私的な娯楽など)は「事業主貸」に分類すること
- 判断に迷う場合は confidence を 0.6 以下にすること
- 必ず以下の JSON 配列のみを返し、前置きや説明文は一切含めないこと
- 入力 hash をそのまま各要素の hash フィールドに返すこと

## 勘定科目一覧

${buildCategoryList(categories)}

## 過去の仕訳例(参考 few-shot)

${buildFewShot(samples)}

## 出力フォーマット(厳守)

[
  {
    "hash": "入力と同じハッシュ値",
    "account": "勘定科目名(上記一覧から 1 つ)",
    "confidence": 0.95,
    "reason": "判断理由(50文字以内)",
    "vendor_guess": "推定される取引先の正式名称"
  }
]`;
}

function buildUserPrompt(transactions) {
  const items = transactions.map(tx => ({
    hash:        tx.hash,
    date:        tx.date,
    description: tx.description,
    amount:      tx.amount,
  }));
  return `以下の取引を仕訳してください:\n\n${JSON.stringify(items, null, 2)}`;
}

// ------------------------------------------------------------------ JSON parse with retry

function parseJsonResponse(text) {
  const cleaned = text
    .replace(/^```(?:json)?\s*\r?\n?/m, '')
    .replace(/\r?\n?```\s*$/m, '')
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('JSON 配列が期待されます');
  return parsed;
}

async function classifyBatchWithRetry(transactions, systemPrompt, maxRetries = 3) {
  const user = buildUserPrompt(transactions);
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const text = await runPrompt({ system: systemPrompt, user, maxTokens: 4096 });
      return parseJsonResponse(text);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        process.stderr.write(`[warn] バッチ分類 attempt ${attempt} 失敗: ${err.message}\n`);
      }
    }
  }
  process.stderr.write(`[error] バッチ分類が ${maxRetries} 回失敗。フォールバック適用。最終エラー: ${lastError.message}\n`);
  return null;
}

// ------------------------------------------------------------------ classify all

async function classifyAll(transactions, opts) {
  const { batchSize, checkInvoice, vendorRegistry } = opts;
  const samples    = recentSamples(20);
  const systemPrompt = buildSystemPrompt(ACCOUNT_CATEGORIES, samples);

  const results = [];

  for (let i = 0; i < transactions.length; i += batchSize) {
    const batch = transactions.slice(i, i + batchSize);
    const end   = Math.min(i + batchSize, transactions.length);
    console.log(`  バッチ分類: ${i + 1}〜${end} 件目 / ${transactions.length} 件`);

    const classified = await classifyBatchWithRetry(batch, systemPrompt);

    for (const tx of batch) {
      let r = classified
        ? classified.find(c => c.hash === tx.hash) || null
        : null;

      if (!r) {
        r = {
          hash:        tx.hash,
          account:     '雑費',
          confidence:  0,
          reason:      'AI 分類失敗のためフォールバック',
          vendor_guess: '',
        };
      }

      const entry = {
        hash:         tx.hash,
        date:         tx.date,
        description:  tx.description,
        amount:       tx.amount,
        account:      String(r.account || '雑費'),
        confidence:   Number(r.confidence) || 0,
        reason:       String(r.reason || ''),
        vendor_guess: String(r.vendor_guess || ''),
        needs_review: (Number(r.confidence) || 0) < 0.7,
      };

      if (checkInvoice) {
        const lookup = lookupVendorRegistration(
          entry.vendor_guess || entry.description,
          vendorRegistry
        );
        entry.registration_number = lookup ? (lookup.registration_number || null) : null;
        entry.invoice_compliant   = lookup
          ? (lookup.registration_number !== null && lookup.registration_number !== '')
          : null;
      } else {
        entry.registration_number = null;
        entry.invoice_compliant   = null;
      }

      entry.categorized_at = toJSTISOString();
      results.push(entry);
    }
  }

  return results;
}

// ------------------------------------------------------------------ output builders

function buildEntriesRows(entries, checkInvoice) {
  return entries.map(e => {
    const row = {
      '日付':   e.date,
      '摘要':   e.description,
      '金額':   e.amount,
      '勘定科目': e.account,
      '信頼度': e.confidence,
      '要確認': e.needs_review ? '要確認' : '',
      '取引先': e.vendor_guess || '',
    };
    if (checkInvoice) {
      row['適格請求書発行事業者番号'] = e.registration_number || '';
      row['インボイス対応'] = e.invoice_compliant === null
        ? '不明' : e.invoice_compliant ? '対応' : '非対応';
    }
    row['理由'] = e.reason || '';
    return row;
  });
}

function buildByAccountRows(entries) {
  const map = new Map();
  for (const e of entries) {
    const acct = e.account;
    if (!map.has(acct)) map.set(acct, { count: 0, total: 0 });
    const r = map.get(acct);
    r.count++;
    r.total += e.amount;
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([acct, r]) => ({
      '勘定科目': acct,
      '件数':     r.count,
      '合計金額': r.total,
    }));
}

function buildSummaryMd(params) {
  const {
    inputPath, format, allCount, skipCount, newCount, reviewCount,
    entries, byAccount, checkInvoice, inputBase,
  } = params;

  const totalAmount = sumAmounts(entries, 'amount');

  const byAccountTable = ['| 勘定科目 | 件数 | 合計金額 |', '|---|---|---|',
    ...byAccount.map(r => `| ${r['勘定科目']} | ${r['件数']} | ${formatJPY(r['合計金額'])} |`),
    `| **合計** | **${allCount}** | **${formatJPY(totalAmount)}** |`,
  ].join('\n');

  const reviewEntries = entries.filter(e => e.needs_review).slice(0, 20);
  const reviewTable = reviewEntries.length === 0
    ? '要確認エントリなし'
    : ['| 日付 | 摘要 | 金額 | 科目 | 信頼度 | 理由 |', '|---|---|---|---|---|---|',
        ...reviewEntries.map(e =>
          `| ${e.date} | ${e.description.slice(0, 30)} | ${formatJPY(e.amount)} | ${e.account} | ${e.confidence.toFixed(2)} | ${(e.reason || '').slice(0, 40)} |`
        ),
      ].join('\n');

  let invoiceSection = '';
  if (checkInvoice) {
    const unknownVendors = [...new Set(
      entries
        .filter(e => e.invoice_compliant === null && e.vendor_guess)
        .map(e => e.vendor_guess)
    )].slice(0, 20);
    const nonCompliant = [...new Set(
      entries
        .filter(e => e.invoice_compliant === false && e.vendor_guess)
        .map(e => e.vendor_guess)
    )].slice(0, 20);

    invoiceSection = `
## インボイス制度の注意事項

> ⚠️ 経過措置の仕入税額控除割合は段階的に縮小しています。税理士に確認のうえ仕訳を確定してください。

### 登録番号が未確認の取引先 (${unknownVendors.length} 件)

${unknownVendors.length > 0
  ? unknownVendors.map(v => `- ${v}`).join('\n')
  : '(なし)'}

### 適格請求書非対応の取引先 (${nonCompliant.length} 件)

${nonCompliant.length > 0
  ? nonCompliant.map(v => `- ${v}`).join('\n')
  : '(なし)'}

vendor-registry.json を編集して登録番号を追加すると、次回実行時にインボイス対応状況が更新されます。
`;
  }

  return `# 経費仕訳サマリ: ${inputBase}

> ⚠️ **AI 補助による出力。最終確認は人 / 税理士が行うこと。**

生成日時: ${tsLabel()}

---

## 概要

| 項目 | 値 |
|---|---|
| 検出形式 | ${format} |
| 対象 CSV | ${inputPath} |
| 総支出取引数 | ${allCount} |
| 既処理スキップ | ${skipCount} |
| 新規分類 | ${newCount} |
| 要確認 | ${reviewCount} |

## 勘定科目別集計

${byAccountTable}

## 要確認エントリ (上位 20 件)

${reviewTable}
${invoiceSection}
---

*このファイルは accounting/scripts/categorize.js により自動生成されました。*
`;
}

// ------------------------------------------------------------------ main

async function main() {
  const opts = parseArgs();
  const { inputPath, format, encoding, checkInvoice, batchSize, dryRun } = opts;

  if (!inputPath) {
    process.stderr.write('使い方: node accounting/scripts/categorize.js <CSV パス> [オプション]\n');
    process.stderr.write('  --format moneyforward|freee|mufg|manual\n');
    process.stderr.write('  --encoding utf8|sjis\n');
    process.stderr.write('  --manual-mapping <json ファイルパス>\n');
    process.stderr.write('  --check-invoice-number\n');
    process.stderr.write('  --batch-size 20\n');
    process.stderr.write('  --dry-run\n');
    process.exit(1);
  }

  const absInput = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(absInput)) {
    process.stderr.write(`ファイルが見つかりません: ${absInput}\n`);
    process.exit(1);
  }

  // manual-mapping 読み込み
  let manualMapping = null;
  if (opts.manualMapping) {
    const mapPath = path.resolve(process.cwd(), opts.manualMapping);
    manualMapping = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  }

  // CSV パース
  console.log(`CSV 読み込み中: ${absInput}`);
  const { format: detectedFormat, transactions: allTx } = parseTransactionsFromCSV(absInput, {
    encoding: encoding === 'sjis' ? 'sjis' : undefined,
    format:   format || undefined,
    manualMapping,
  });
  console.log(`  検出形式: ${detectedFormat} / 総トランザクション: ${allTx.length} 件`);

  // 支出のみ抽出(amount > 0)
  const allExpenses = allTx.filter(tx => tx.amount > 0);
  const incomeCount = allTx.length - allExpenses.length;
  console.log(`  支出: ${allExpenses.length} 件 / 収入(スキップ): ${incomeCount} 件`);

  // ハッシュ付与
  allExpenses.forEach(tx => { tx.hash = computeHash(tx); });

  // 処理済み確認
  const processedMap = loadProcessed();
  const newExpenses     = allExpenses.filter(tx => !processedMap.has(tx.hash));
  const skippedExpenses = allExpenses.filter(tx =>  processedMap.has(tx.hash));
  const skipCount = skippedExpenses.length;
  console.log(`  既処理スキップ: ${skipCount} 件 / 新規分類対象: ${newExpenses.length} 件`);

  // vendor registry
  const vendorRegistry = checkInvoice ? loadVendorRegistry() : {};

  // dry-run: サマリだけ出して終了
  if (dryRun) {
    console.log('\n[DRY RUN] 分類対象:');
    newExpenses.forEach(tx =>
      console.log(`  ${tx.date} ${tx.description.slice(0, 40).padEnd(40)} ${formatJPY(tx.amount)}`)
    );
    console.log('\n[DRY RUN] state ファイルは更新しません。');
    return;
  }

  if (newExpenses.length === 0) {
    console.log('新規分類対象なし。処理を終了します。');
    return;
  }

  // AI 分類
  console.log('\nClaude API で仕訳を開始します...');
  const newEntries = await classifyAll(newExpenses, { batchSize, checkInvoice, vendorRegistry });

  // 検算: 入力 = スキップ + 新規
  if (allExpenses.length !== skipCount + newEntries.length) {
    throw new Error(`検算エラー: 入力 ${allExpenses.length} ≠ スキップ ${skipCount} + 分類 ${newEntries.length}`);
  }

  // state 更新
  for (const entry of newEntries) {
    processedMap.set(entry.hash, entry);
  }
  saveProcessed(processedMap);
  console.log(`\ncategorized.json に ${newEntries.length} 件を保存しました。`);

  // 全エントリ(CSV 順)を再構成
  const allEntries = allExpenses.map(tx => {
    if (processedMap.has(tx.hash) && skippedExpenses.find(s => s.hash === tx.hash)) {
      return { ...tx, ...processedMap.get(tx.hash) };
    }
    return newEntries.find(e => e.hash === tx.hash) || { ...tx };
  });

  // 出力ファイル
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  const inputBase    = path.basename(absInput, '.csv');
  const entriesPath  = path.resolve(OUTPUTS_DIR, `${inputBase}.entries.csv`);
  const byAcctPath   = path.resolve(OUTPUTS_DIR, `${inputBase}.by-account.csv`);
  const summaryPath  = path.resolve(OUTPUTS_DIR, `${inputBase}.summary.md`);

  const entriesRows  = buildEntriesRows(allEntries, checkInvoice);
  const byAcctRows   = buildByAccountRows(allEntries);
  const reviewCount  = allEntries.filter(e => e.needs_review).length;

  writeCSV(entriesRows,  entriesPath);
  writeCSV(byAcctRows,   byAcctPath);

  const summaryMd = buildSummaryMd({
    inputPath:  absInput,
    format:     detectedFormat,
    allCount:   allExpenses.length,
    skipCount,
    newCount:   newEntries.length,
    reviewCount,
    entries:    allEntries,
    byAccount:  byAcctRows,
    checkInvoice,
    inputBase,
  });
  fs.writeFileSync(summaryPath, summaryMd, 'utf8');

  console.log(`\n出力ファイル:`);
  console.log(`  entries:    ${entriesPath}`);
  console.log(`  by-account: ${byAcctPath}`);
  console.log(`  summary:    ${summaryPath}`);
  console.log(`\n  要確認: ${reviewCount} 件`);

  // 勘定科目別サマリをコンソールに
  console.log('\n勘定科目別集計:');
  byAcctRows.forEach(r => console.log(`  ${r['勘定科目'].padEnd(12)} ${r['件数']} 件  ${formatJPY(r['合計金額'])}`));
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
