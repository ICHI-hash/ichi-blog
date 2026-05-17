'use strict';
const fs   = require('fs');
const path = require('path');
const matter = require('gray-matter');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { sendMail }                       = require('../lib/mailer');
const { makePayableId, isSent, recordSent } = require('../lib/payables-state');
const { formatJPY }                      = require('../lib/money');

const { pathForInputs, pathForOutputs } = require('../../lib/paths.js');
const PAYABLES_DIR = pathForInputs('accounting', 'payables');
const OUTPUTS_DIR  = pathForOutputs('accounting', 'payments');

// ------------------------------------------------------------------ JST helpers

function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function diffDays(laterStr, earlierStr) {
  const ms = new Date(laterStr + 'T00:00:00+09:00') - new Date(earlierStr + 'T00:00:00+09:00');
  return Math.round(ms / 86400000);
}

// ------------------------------------------------------------------ CLI

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    aheadDays:      [3, 7],
    includeOverdue: true,
    to:             null,
    noMail:         false,
    dryRun:         false,
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--ahead-days') {
      opts.aheadDays = args[++i].split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
    } else if (a === '--no-overdue') {
      opts.includeOverdue = false;
    } else if (a === '--to') {
      opts.to = args[++i];
    } else if (a === '--no-mail') {
      opts.noMail = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    }
    i++;
  }
  return opts;
}

// ------------------------------------------------------------------ validation

function validatePayable(fm, filepath) {
  const errs = [];
  if (!fm.vendor_name)    errs.push('vendor_name が未設定');
  if (!fm.invoice_number) errs.push('invoice_number が未設定');
  if (!Number.isInteger(fm.amount) || fm.amount <= 0) errs.push(`amount が正の整数でない (値: ${fm.amount})`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fm.due_date || ''))) errs.push(`due_date が YYYY-MM-DD 形式でない (値: ${fm.due_date})`);
  if (!fm.payment_method) errs.push('payment_method が未設定');
  if (errs.length > 0) {
    errs.forEach(e => process.stderr.write(`[warn] ${path.basename(filepath)}: ${e}\n`));
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ reminder type

function getReminderType(daysToDue, opts) {
  if (daysToDue < 0 && opts.includeOverdue) return 'overdue';
  if (daysToDue === 0) return 'today';
  if (opts.aheadDays.includes(daysToDue)) return `${daysToDue}days`;
  return null;
}

// ------------------------------------------------------------------ email body builder

function buildEmailBody(groups, today) {
  const lines = [
    `本日 (${today}) の支払予定リマインダーです。`,
    '※ 経理部門の自動生成。最終的な支払判断は人が行うこと。',
  ];

  function section(icon, label, items) {
    if (items.length === 0) return;
    const total = items.reduce((s, p) => s + p.amount, 0);
    lines.push('');
    lines.push('──────────────────────────');
    lines.push(`${icon} ${label} (${items.length} 件、合計 ${formatJPY(total)})`);
    lines.push('──────────────────────────');
    for (const p of items) {
      const elapsed = p.daysToDue < 0 ? ` (${-p.daysToDue} 日超過)` : '';
      lines.push(`• ${p.vendor_name} / ${p.invoice_number}  ${formatJPY(p.amount)}`);
      lines.push(`  期日: ${p.due_date}${elapsed}`);
      lines.push(`  支払方法: ${p.payment_method}`);
      if (p.note) lines.push(`  備考: ${String(p.note).trim().replace(/\n/g, ' ')}`);
    }
  }

  section('⚠️', '期日超過', groups.overdue || []);
  section('📌', '本日支払', groups.today   || []);

  // ahead-days 昇順でセクションを出す
  const aheadKeys = Object.keys(groups)
    .filter(k => k.endsWith('days'))
    .sort((a, b) => parseInt(a) - parseInt(b));
  for (const key of aheadKeys) {
    const n = parseInt(key);
    section('📅', `期日 ${n} 日以内`, groups[key] || []);
  }

  lines.push('');
  lines.push('--');
  lines.push('ICHI 経理自動化 (accounting/scripts/payments.js)');
  return lines.join('\n');
}

// ------------------------------------------------------------------ subject builder

function buildSubject(groups, today) {
  const overdueCount = (groups.overdue || []).length;
  const nearCount = Object.entries(groups)
    .filter(([k]) => k !== 'overdue')
    .reduce((s, [, v]) => s + v.length, 0);

  const parts = [];
  if (overdueCount > 0) parts.push(`期日超過 ${overdueCount} 件`);
  if (nearCount  > 0) parts.push(`期日近接 ${nearCount} 件`);
  return `【ICHI 支払予定】${parts.join(' / ')} (${today})`;
}

// ------------------------------------------------------------------ Markdown output

function buildOutputMd(groups, skippedOutOfWindow, today) {
  const lines = [
    '> ⚠️ **経理自動生成。最終的な支払操作は人が銀行アプリ等で実施してください。**',
    '',
    `生成日時: ${today}`,
    '',
    '---',
    '',
  ];

  function mdSection(icon, label, items) {
    if (items.length === 0) return;
    const total = items.reduce((s, p) => s + p.amount, 0);
    lines.push(`## ${icon} ${label}`);
    lines.push('');
    lines.push(`合計: ${formatJPY(total)} (${items.length} 件)`);
    lines.push('');
    lines.push('| 取引先 | 請求書番号 | 金額 | 期日 | 支払方法 | 備考 |');
    lines.push('|---|---|---|---|---|---|');
    for (const p of items) {
      const elapsed = p.daysToDue < 0 ? ` (${-p.daysToDue}日超過)` : '';
      lines.push(`| ${p.vendor_name} | ${p.invoice_number} | ${formatJPY(p.amount)} | ${p.due_date}${elapsed} | ${p.payment_method} | ${String(p.note || '').trim().replace(/\n/g, ' ')} |`);
    }
    lines.push('');
  }

  mdSection('⚠️', '期日超過', groups.overdue || []);
  mdSection('📌', '本日支払', groups.today   || []);

  const aheadKeys = Object.keys(groups)
    .filter(k => k.endsWith('days'))
    .sort((a, b) => parseInt(a) - parseInt(b));
  for (const key of aheadKeys) {
    const n = parseInt(key);
    mdSection('📅', `期日 ${n} 日以内`, groups[key] || []);
  }

  if (skippedOutOfWindow.length > 0) {
    lines.push('---', '');
    lines.push('## 参考: 対象外の未払支払予定（期日範囲外）', '');
    lines.push('| 取引先 | 請求書番号 | 金額 | 期日 | 残日数 |');
    lines.push('|---|---|---|---|---|');
    for (const p of skippedOutOfWindow) {
      lines.push(`| ${p.vendor_name} | ${p.invoice_number} | ${formatJPY(p.amount)} | ${p.due_date} | ${p.daysToDue} 日 |`);
    }
    lines.push('');
  }

  lines.push('---', '');
  lines.push('*このファイルは accounting/scripts/payments.js により自動生成されました。*');
  return lines.join('\n');
}

// ------------------------------------------------------------------ main

async function main() {
  const opts  = parseArgs();
  const today = todayJST();

  // 1. payables/*.md を全件読み込み
  let files;
  try {
    files = fs.readdirSync(PAYABLES_DIR).filter(f => f.endsWith('.md') && f !== '.gitkeep' && f !== 'README.md');
  } catch {
    process.stderr.write(`[warn] payables ディレクトリが読み込めません: ${PAYABLES_DIR}\n`);
    files = [];
  }

  const payables = [];
  for (const file of files) {
    const filepath = path.resolve(PAYABLES_DIR, file);
    try {
      const { data: fm } = matter(fs.readFileSync(filepath, 'utf8'));
      // due_date が Date オブジェクトで来る場合は文字列に変換
      if (fm.due_date instanceof Date) fm.due_date = fm.due_date.toISOString().slice(0, 10);
      fm.due_date = String(fm.due_date || '').slice(0, 10);
      if (!validatePayable(fm, filepath)) continue;
      payables.push({ ...fm, _file: file });
    } catch (err) {
      process.stderr.write(`[warn] ${file}: パース失敗 (${err.message})\n`);
    }
  }

  console.log(`payables 読み込み: ${files.length} ファイル / 有効 ${payables.length} 件`);

  // 2. paid=true を除外
  const unpaid = payables.filter(p => p.paid !== true);
  const paidCount = payables.length - unpaid.length;
  console.log(`  除外(paid=true): ${paidCount} 件 / 未払: ${unpaid.length} 件`);

  // 3. reminder_type を決定
  const groups         = {};   // reminderType → payable[]
  const skippedOutOfWindow = [];

  for (const p of unpaid) {
    const daysToDue    = diffDays(p.due_date, today);
    const reminderType = getReminderType(daysToDue, opts);
    p.daysToDue        = daysToDue;

    if (!reminderType) {
      skippedOutOfWindow.push(p);
      continue;
    }
    p.reminderType = reminderType;
    if (!groups[reminderType]) groups[reminderType] = [];
    groups[reminderType].push(p);
  }

  // 4. 重複送信チェック
  const toSend = [];
  const skippedAlreadySent = [];

  for (const [rType, items] of Object.entries(groups)) {
    for (const p of items) {
      const payableId = makePayableId(p.vendor_name, p.invoice_number);
      if (isSent(payableId, rType, today)) {
        skippedAlreadySent.push(p);
      } else {
        toSend.push({ ...p, reminderType: rType });
      }
    }
  }

  // groups を toSend だけに絞り直す
  const sendGroups = {};
  for (const p of toSend) {
    if (!sendGroups[p.reminderType]) sendGroups[p.reminderType] = [];
    sendGroups[p.reminderType].push(p);
  }

  const totalSend = toSend.length;
  console.log(`  送信対象: ${totalSend} 件 / スキップ(送信済): ${skippedAlreadySent.length} 件`);
  Object.entries(sendGroups).forEach(([k, v]) => console.log(`    ${k}: ${v.length} 件`));

  if (totalSend === 0) {
    console.log('本日リマインダー対象なし。');
    // Markdown は出力する（参考セクションのみ）
    if (!opts.dryRun) {
      const md = buildOutputMd({}, skippedOutOfWindow, today);
      fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
      const outPath = path.resolve(OUTPUTS_DIR, `${today}.md`);
      fs.writeFileSync(outPath, md, 'utf8');
      console.log(`支払予定 Markdown: ${outPath}`);
    }
    return;
  }

  // 5〜6. メール本文生成 + 送信
  const subject = buildSubject(sendGroups, today);
  const body    = buildEmailBody(sendGroups, today);

  if (opts.dryRun) {
    await sendMail({ to: opts.to, subject, body, dryRun: true });
    console.log('\n[DRY RUN] state ファイル・出力ファイルは更新しません。');
    return;
  }

  let mailSent = false;
  if (!opts.noMail) {
    try {
      const result = await sendMail({ to: opts.to, subject, body });
      mailSent = result.sent;
      if (mailSent) console.log(`メール送信成功 (messageId: ${result.messageId})`);
    } catch (err) {
      process.stderr.write(`[error] メール送信失敗: ${err.message}\n`);
      process.stderr.write('[info] ファイル出力は継続します。state への記録はスキップします。\n');
    }
  } else {
    console.log('--no-mail: メール送信・送信済み記録をスキップしました。');
  }

  // 7. 送信済み記録を更新（メール送信成功時のみ。失敗・--no-mail はスキップ）
  if (mailSent) {
    for (const p of toSend) {
      recordSent({
        vendor_name:    p.vendor_name,
        invoice_number: p.invoice_number,
        due_date:       p.due_date,
        amount:         p.amount,
        reminder_type:  p.reminderType,
        today,
      });
    }
    console.log(`payments-sent.json に ${toSend.length} 件を記録しました。`);
  }

  // 8. 支払予定 Markdown 出力
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  const outPath = path.resolve(OUTPUTS_DIR, `${today}.md`);
  const allGroups = {};
  for (const p of unpaid) {
    if (!p.reminderType) continue;
    if (!allGroups[p.reminderType]) allGroups[p.reminderType] = [];
    allGroups[p.reminderType].push(p);
  }
  const md = buildOutputMd(allGroups, skippedOutOfWindow, today);
  fs.writeFileSync(outPath, md, 'utf8');

  console.log(`\n出力ファイル: ${outPath}`);
  if (opts.noMail) {
    console.log('  メール本文プレビュー:');
    console.log(subject);
    console.log(body);
  }
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
