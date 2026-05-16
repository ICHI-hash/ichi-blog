'use strict';
/**
 * accounting/scripts/tax-rates-check.js
 * 現在のリポジトリ税率設定を Markdown チェックリストまたは JSON で出力する。
 *
 * 使い方:
 *   node accounting/scripts/tax-rates-check.js               # Markdown (既定)
 *   node accounting/scripts/tax-rates-check.js --format json  # JSON
 *
 * GitHub Actions から Issue 本文として利用する。
 */
const { buildSummary } = require('../lib/tax-rates-summary');

// ------------------------------------------------------------------ CLI

function parseArgs() {
  const args    = process.argv.slice(2);
  const fmt     = args.includes('--format')
    ? args[args.indexOf('--format') + 1]
    : 'markdown';
  return { format: fmt === 'json' ? 'json' : 'markdown' };
}

// ------------------------------------------------------------------ date

function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ Markdown builder

function buildMarkdown(summary) {
  const today  = todayJST();
  const r      = summary.rates;
  const lines  = [];

  lines.push(`# 税制改正年次チェック (生成日: ${today})`);
  lines.push('');
  lines.push('> このチェックリストは毎年 4 月の税制改正タイミングで自動生成されます。');
  lines.push('> 各項目を国税庁・財務省の最新情報と照合し、変更があれば');
  lines.push('> `accounting/lib/tax-rates.js` と `accounting/lib/tax-estimate.js` を更新してください。');
  lines.push('');
  lines.push(`## 現在のリポジトリ設定 (last_updated: ${summary.last_updated})`);
  lines.push('');

  // 消費税
  lines.push('### 消費税');
  lines.push('');
  lines.push(`- [ ] 標準税率: ${r.consumption_standard}%`);
  lines.push(`- [ ] 軽減税率: ${r.consumption_reduced}%`);
  lines.push('');

  // 源泉徴収
  lines.push('### 源泉徴収（個人事業主・士業向け）');
  lines.push('');
  lines.push(`- [ ] 閾値: ${r.withholding_threshold.toLocaleString('ja-JP')} 円`);
  lines.push(`- [ ] 閾値以下: ${r.withholding_low_rate_pct}`);
  lines.push(`- [ ] 閾値超過: ${r.withholding_high_rate_pct} + ${r.withholding_base_amount.toLocaleString('ja-JP')} 円`);
  lines.push('');

  // 所得税
  lines.push('### 所得税（超過累進）');
  lines.push('');
  r.income_brackets.forEach((b, i) => {
    const limitStr = b.limit != null
      ? `${b.limit.toLocaleString('ja-JP')} 円以下`
      : '40,000,001 円以上';
    const dedStr   = b.deduction > 0 ? ` (控除額 ${b.deduction.toLocaleString('ja-JP')} 円)` : ' (控除額 0)';
    lines.push(`- [ ] 第 ${i + 1} 段階 — ${limitStr}: ${b.rate}${dedStr}`);
  });
  lines.push('');

  // 住民税
  lines.push('### 住民税');
  lines.push('');
  lines.push(`- [ ] 一律: ${r.resident_tax_rate} (均等割は別途 年 5,000 円程度)`);
  lines.push('');

  // 簡易課税みなし仕入率
  lines.push('### 簡易課税みなし仕入率');
  lines.push('');
  for (const cat of r.consumption_simple_categories) {
    lines.push(`- [ ] 第 ${cat.code} 種 ${cat.name}: ${cat.rate}`);
  }
  lines.push('');

  // 確認リファレンス
  lines.push('## 確認すべきリファレンス');
  lines.push('');
  for (const ref of summary.references) {
    lines.push(`- [${ref.title}](${ref.url})`);
  }
  lines.push('');

  // 更新手順
  lines.push('## 改正発覚時の更新手順');
  lines.push('');
  lines.push('改正があった場合:');
  lines.push('');
  lines.push('1. `accounting/lib/tax-rates.js` の定数を更新');
  lines.push('2. `accounting/lib/tax-estimate.js` の累進テーブルを更新');
  lines.push('3. `accounting/lib/tax-rates.js` の `LAST_UPDATED` を更新 (例: `\'2027-04\'`)');
  lines.push('4. `accounting/README.md` の「法令時点」セクションを更新');
  lines.push('5. 動作確認:');
  lines.push('   ```bash');
  lines.push('   npm run tax-rates-check');
  lines.push('   npm run monthly-report -- <yyyymm> --dry-run  # 月次レポートの値が変わったか確認');
  lines.push('   ```');
  lines.push('');
  lines.push('---');
  lines.push(`*accounting/scripts/tax-rates-check.js 生成 (${today})*`);

  return lines.join('\n');
}

// ------------------------------------------------------------------ main

function main() {
  const { format } = parseArgs();
  const summary    = buildSummary();

  if (format === 'json') {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write(buildMarkdown(summary) + '\n');
  }
}

main();
