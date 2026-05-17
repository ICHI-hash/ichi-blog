'use strict';
const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { collectWonDeals, makeDealKey }   = require('../lib/sales-bridge');
const { isGenerated, recordGenerated }   = require('../lib/sales-bridge-state');
const { generateDraft }                  = require('../lib/invoice-draft-generator');
const { isConfigured, sendMail }         = require('../../lib/mailer');

const { pathForInputs, pathForOutputs } = require('../../lib/paths.js');
const INVOICES_DIR  = pathForInputs('accounting', 'invoices');
const OUTPUTS_DIR   = pathForOutputs('accounting', 'sync-from-sales');

// ------------------------------------------------------------------ JST helpers

function toJSTISOString() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00');
}
function todayJST() { return toJSTISOString().slice(0, 10); }
function tsLabel()  { const s = toJSTISOString(); return `${s.slice(0,10)} ${s.slice(11,19)}`; }

// ------------------------------------------------------------------ CLI

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    source:  'auto',
    since:   null,
    noAi:    false,
    dryRun:  false,
    to:      null,
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if      (a === '--source') opts.source = args[++i];
    else if (a === '--since')  opts.since  = new Date(args[++i] + 'T00:00:00+09:00');
    else if (a === '--no-ai')  opts.noAi   = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--to')     opts.to     = args[++i];
    i++;
  }
  return opts;
}

// ------------------------------------------------------------------ filename

function sanitizeName(s) {
  return s.replace(/\s+/g, '-').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 50);
}

function draftFilename(today, deal) {
  const base = `draft-${today.replace(/-/g, '')}-${sanitizeName(deal.project_name)}`;
  let   dest = path.resolve(INVOICES_DIR, `${base}.md`);
  let   n    = 1;
  while (fs.existsSync(dest)) {
    dest = path.resolve(INVOICES_DIR, `${base}-${++n}.md`);
  }
  return dest;
}

// ------------------------------------------------------------------ summary builders

function buildSummaryMd(today, results) {
  const { detected, generated, skipped, items } = results;
  const lines = [
    `# 営業 → 経理 受注連携サマリ (${today})`,
    '',
    `生成日時: ${tsLabel()}`,
    '',
    '## 概要',
    '',
    '| 項目 | 件数 |',
    '|---|---|',
    `| 検出受注案件 | ${detected} |`,
    `| 新規下書き生成 | ${generated} |`,
    `| 既処理スキップ | ${skipped} |`,
    '',
    '## 生成した下書き',
    '',
  ];

  if (items.length === 0) {
    lines.push('(なし)');
  } else {
    for (const item of items) {
      const mark    = item.needs_review ? '⚠️ 要確認' : '✅ 確定';
      const amount  = item.amount != null ? `¥${item.amount.toLocaleString('ja-JP')}` : '¥?';
      lines.push(`### ${mark} ${path.basename(item.draft_path)}`);
      lines.push(`- 顧客: ${item.client_name}`);
      lines.push(`- 金額: ${amount} / ソース: ${item.billing_source}`);
      lines.push(`- パス: \`${item.draft_path}\``);
      if (item.warnings && item.warnings.length > 0) {
        item.warnings.forEach(w => lines.push(`- ⚠️ ${w}`));
      }
      lines.push('');
    }
  }

  lines.push('## 次の手順');
  lines.push('');
  lines.push('1. 各下書きを開いて内容を確認・編集');
  lines.push('2. 問題なければ:');
  lines.push('   ```bash');
  lines.push('   npm run invoice -- <下書きファイルパス>');
  lines.push('   ```');
  lines.push('');
  lines.push('---');
  lines.push('*accounting/scripts/sync-from-sales.js により自動生成*');

  return lines.join('\n');
}

function buildNotificationBody(today, results) {
  const { detected, generated, skipped, items } = results;
  const lines = [
    `本日 (${today}) の受注案件 → 請求書下書き生成サマリです。`,
    '',
    `検出受注案件: ${detected} 件`,
    `新規下書き生成: ${generated} 件`,
    `既処理スキップ: ${skipped} 件`,
    '',
  ];
  for (const item of items) {
    const mark   = item.needs_review ? '⚠️' : '✅';
    const amount = item.amount != null ? `¥${item.amount.toLocaleString('ja-JP')}` : '¥?';
    lines.push(`${mark} ${item.client_name} / ${item.project_name}`);
    lines.push(`   金額: ${amount} / ${item.billing_source}`);
    if (item.needs_review) lines.push(`   → 確認が必要です`);
    lines.push('');
  }
  lines.push('各下書きを確認後 npm run invoice -- <パス> で PDF を発行してください。');
  lines.push('');
  lines.push('--');
  lines.push('ICHI 経理自動化 (accounting/scripts/sync-from-sales.js)');
  return lines.join('\n');
}

// ------------------------------------------------------------------ main

async function main() {
  const opts  = parseArgs();
  const today = todayJST();

  console.log(`営業 → 経理 受注連携: ${today}`);
  if (opts.dryRun) console.log('[DRY RUN] ファイル保存・state 更新はしません。');

  // 1. 受注案件を取得
  const deals = await collectWonDeals({ source: opts.source, since: opts.since });
  console.log(`  検出受注案件: ${deals.length} 件`);

  // 2. 重複チェックと下書き生成
  const results = { detected: deals.length, generated: 0, skipped: 0, items: [] };

  for (const deal of deals) {
    const key = makeDealKey(deal);
    if (isGenerated(key)) {
      console.log(`  スキップ(既処理): ${deal.project_name}`);
      results.skipped++;
      continue;
    }

    // 下書き生成
    const { markdown, metadata } = await generateDraft(deal, { noAi: opts.noAi });
    const { has_amount, needs_review, billing_source, warnings } = metadata;

    if (opts.dryRun) {
      const mark = needs_review ? '[⚠️]' : '[✓]';
      const amt  = deal.billing?.amount != null ? `¥${deal.billing.amount.toLocaleString('ja-JP')}` : '¥?';
      console.log(`  ${mark} ${deal.project_name} / ${deal.client_name} / ${amt}`);
      results.generated++;
      continue;
    }

    // ファイル保存
    fs.mkdirSync(INVOICES_DIR, { recursive: true });
    const destPath = draftFilename(today, deal);
    fs.writeFileSync(destPath, markdown, 'utf8');
    const relPath = path.relative(ACC_ROOT, destPath).replace(/\\/g, '/');

    // state 記録
    recordGenerated({
      deal_key:       key,
      project_name:   deal.project_name,
      client_name:    deal.client_name,
      draft_path:     relPath,
      needs_review,
      amount:         deal.billing?.amount ?? null,
      billing_source,
    });

    const mark = needs_review ? '⚠️' : '✅';
    const amt  = deal.billing?.amount != null ? `¥${deal.billing.amount.toLocaleString('ja-JP')}` : '¥?';
    console.log(`  [${mark}] ${relPath}`);
    console.log(`       ${deal.client_name} / ${amt} / ${billing_source}`);
    if (warnings.length > 0) warnings.forEach(w => console.log(`       ⚠️  ${w}`));

    results.generated++;
    results.items.push({ ...metadata, draft_path: relPath,
      client_name: deal.client_name, project_name: deal.project_name,
      amount: deal.billing?.amount ?? null, warnings });
  }

  if (!opts.dryRun) {
    // 出力ファイル生成
    fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
    const summaryPath = path.resolve(OUTPUTS_DIR, `${today}.md`);
    fs.writeFileSync(summaryPath, buildSummaryMd(today, results), 'utf8');
    console.log(`\n出力: ${summaryPath}`);
  }

  console.log(`\n  新規生成: ${results.generated} 件 / スキップ: ${results.skipped} 件`);

  if (!opts.dryRun && results.generated > 0) {
    // 通知メール送信
    if (isConfigured()) {
      try {
        await sendMail({
          to:      opts.to,
          subject: `【ICHI 経理】新規受注案件 ${results.generated} 件の請求書下書きを生成 (${today})`,
          body:    buildNotificationBody(today, results),
        });
        console.log('通知メール送信完了');
      } catch (err) {
        process.stderr.write(`[warn] 通知メール送信失敗: ${err.message}\n`);
      }
    }

    console.log('\n次の手順:');
    console.log('  1. 各下書きを開いて内容を確認・編集');
    console.log('  2. npm run invoice -- <下書きファイルパス>');
  }
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
