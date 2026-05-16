/**
 * sales/scripts/morning-reminder.js
 * 毎朝 09:00 JST 想定で、営業パイプラインの要対応案件をメールで通知する。
 *
 * データソース:
 *   1. SALES_SHEET_ID が設定されていれば Google Sheets から取得
 *   2. なければ sales/inputs/pipeline/*.md (frontmatter) を読む
 *
 * CLI:
 *   node sales/scripts/morning-reminder.js [--dry-run] [--no-mail]
 */
import 'dotenv/config';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

import { sendMail, isConfigured } from '../lib/mailer.js';

const _require  = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const matter    = _require('gray-matter');

const PIPELINE_DIR = path.resolve(__dirname, '../inputs/pipeline');

// ------------------------------------------------------------------ date helpers

function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function diffDays(dueDateStr, todayStr) {
  const due   = new Date(dueDateStr + 'T00:00:00+09:00');
  const today = new Date(todayStr   + 'T00:00:00+09:00');
  return Math.round((due - today) / 86400000);
}

// ------------------------------------------------------------------ CLI

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    noMail: args.includes('--no-mail'),
    to:     (args.find(a => a.startsWith('--to=') ) || '').replace('--to=', '') || null,
  };
}

// ------------------------------------------------------------------ data collection

/**
 * Google Sheets からパイプライン案件を取得する。
 * SALES_SHEET_ID が設定されていて Sheets API が利用可能な場合のみ動作。
 * 失敗時は null を返してフォールバックを促す。
 * 想定シート構造 (A〜F列, 1行目ヘッダ):
 *   project_name, client_name, stage, next_action, next_action_due, owner_note
 */
async function collectFromSheets() {
  const sheetId = process.env.SALES_SHEET_ID;
  if (!sheetId) return null;

  try {
    const { createRequire } = await import('module');
    const req    = createRequire(import.meta.url);
    const goog   = req('googleapis');
    const google = goog.google ?? goog;

    // Gmail OAuth2 で Sheets を試みる (スコープが合えば動く)
    const { getOAuthClient } = req(
      path.resolve(__dirname, '../../lib/mailer.js')
    );
    const auth   = getOAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'A2:F',
    });

    const rows = res.data.values || [];
    return rows
      .filter(r => r[0]) // project_name 必須
      .map(r => ({
        project_name:     r[0] || '',
        client_name:      r[1] || '',
        stage:            r[2] || '',
        next_action:      r[3] || '',
        next_action_due:  r[4] || '',
        owner_note:       r[5] || '',
      }));
  } catch (err) {
    process.stderr.write(`[warn] Sheets 取得失敗 (${err.message})。ローカルファイルにフォールバック。\n`);
    return null;
  }
}

/**
 * sales/inputs/pipeline/*.md からパイプライン案件を読み込む。
 */
function collectFromLocalFiles() {
  const items = [];
  let files = [];
  try {
    files = fs.readdirSync(PIPELINE_DIR).filter(f => f.endsWith('.md') && f !== 'README.md');
  } catch {
    return [];
  }

  for (const file of files) {
    try {
      const { data: fm } = matter(fs.readFileSync(path.resolve(PIPELINE_DIR, file), 'utf8'));
      if (!fm.project_name) continue;
      // next_action_due は YAML がDate objectに変換する場合があるため正規化
      const rawDue = fm.next_action_due;
      const dueDateStr = rawDue instanceof Date
        ? rawDue.toISOString().slice(0, 10)
        : String(rawDue || '').trim().slice(0, 10);

      items.push({
        project_name:    String(fm.project_name || '').trim(),
        client_name:     String(fm.client_name  || '').trim(),
        stage:           String(fm.stage        || '').trim(),
        next_action:     String(fm.next_action  || '').trim(),
        next_action_due: dueDateStr,
        owner_note:      String(fm.owner_note   || '').trim(),
      });
    } catch (err) {
      process.stderr.write(`[warn] ${file}: パース失敗 (${err.message})\n`);
    }
  }
  return items;
}

/**
 * データソースを選択して案件リストを返す。
 */
async function collectActionItems() {
  const fromSheets = await collectFromSheets();
  if (fromSheets !== null) {
    console.log(`Sheets から ${fromSheets.length} 件取得`);
    return fromSheets;
  }
  const fromLocal = collectFromLocalFiles();
  console.log(`ローカルファイルから ${fromLocal.length} 件取得`);
  return fromLocal;
}

// ------------------------------------------------------------------ grouping

function groupByUrgency(items, today) {
  const overdue = [];
  const todayItems = [];
  const upcoming = [];

  for (const item of items) {
    if (!item.next_action_due) continue;
    const diff = diffDays(item.next_action_due, today);
    if (diff < 0)     overdue.push({ ...item, diff });
    else if (diff === 0) todayItems.push({ ...item, diff });
    else              upcoming.push({ ...item, diff });
  }
  // 期日超過は古い順、upcoming は近い順
  overdue.sort((a, b) => a.diff - b.diff);
  upcoming.sort((a, b) => a.diff - b.diff);
  return { overdue, today: todayItems, upcoming };
}

// ------------------------------------------------------------------ email builders

function formatItem(item) {
  const lines = [
    `• ${item.client_name || '(顧客名未設定)'} / ${item.project_name}`,
    `  ステージ: ${item.stage || '-'}`,
  ];
  if (item.next_action_due) {
    const dueLabel = item.diff < 0
      ? `期日 ${item.next_action_due}、${-item.diff} 日超過`
      : item.diff === 0
        ? `期日 ${item.next_action_due}、本日`
        : `期日 ${item.next_action_due}、${item.diff} 日後`;
    lines.push(`  次のアクション: ${item.next_action || '-'} (${dueLabel})`);
  } else {
    lines.push(`  次のアクション: ${item.next_action || '-'}`);
  }
  if (item.owner_note) lines.push(`  メモ: ${item.owner_note}`);
  return lines.join('\n');
}

function buildEmailBody(groups, today) {
  const lines = [
    `本日 (${today}) の営業要対応リマインダーです。`,
    '',
  ];

  function section(icon, label, items) {
    if (items.length === 0) return;
    lines.push('──────────────────────────');
    lines.push(`${icon} ${label} (${items.length} 件)`);
    lines.push('──────────────────────────');
    for (const item of items) lines.push(formatItem(item));
    lines.push('');
  }

  section('⚠️', '期日超過', groups.overdue);
  section('📌', '本日対応', groups.today);
  section('📅', '今後の対応予定', groups.upcoming);

  lines.push('--');
  lines.push('ICHI 営業自動化 (sales/scripts/morning-reminder.js)');
  return lines.join('\n');
}

function buildSubject(groups, today) {
  const parts = [];
  if (groups.overdue.length > 0) parts.push(`期日超過 ${groups.overdue.length} 件`);
  if (groups.today.length  > 0) parts.push(`本日対応 ${groups.today.length} 件`);
  if (parts.length === 0 && groups.upcoming.length > 0) parts.push(`今後 ${groups.upcoming.length} 件`);
  return `【ICHI 営業】${parts.join(' / ') || '要対応なし'} (${today})`;
}

// ------------------------------------------------------------------ main

async function main() {
  const opts  = parseArgs();
  const today = todayJST();

  console.log(`営業朝リマインダー: ${today}`);

  const allItems = await collectActionItems();
  if (allItems.length === 0) {
    console.log('パイプライン案件なし。処理を終了します。');
    return;
  }

  const groups = groupByUrgency(allItems, today);
  const actionCount = groups.overdue.length + groups.today.length;
  console.log(`  期日超過: ${groups.overdue.length} 件 / 本日: ${groups.today.length} 件 / 今後: ${groups.upcoming.length} 件`);

  if (actionCount === 0 && !opts.dryRun) {
    console.log('本日対応・期日超過の案件なし。メール送信をスキップします。');
    return;
  }

  const subject = buildSubject(groups, today);
  const body    = buildEmailBody(groups, today);

  if (opts.dryRun) {
    await sendMail({ to: opts.to, subject, body, dryRun: true });
    console.log('\n[DRY RUN] state ファイルは更新しません。');
    return;
  }

  if (opts.noMail) {
    console.log('--no-mail: メール送信をスキップしました。');
    console.log(`\n件名: ${subject}`);
    console.log(body);
    return;
  }

  try {
    const result = await sendMail({ to: opts.to, subject, body });
    if (result.sent) console.log(`メール送信成功 (messageId: ${result.messageId})`);
  } catch (err) {
    process.stderr.write(`[error] メール送信失敗: ${err.message}\n`);
  }
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
