'use strict';
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { isConfigured, searchMessages, getMessage, downloadAttachment } = require('../../lib/mailer');
const { isProcessed, recordProcessed }  = require('../lib/receipt-fetch-state');
const { addReceipts, findByPath, loadIndex } = require('../lib/receipts-index');
const { ocrReceipt }                    = require('../lib/receipt-ocr');
const { writeCSV }                      = require('../lib/csv');

const ACC_ROOT       = path.resolve(__dirname, '..');
const RECEIPTS_BASE  = path.resolve(ACC_ROOT, 'inputs/receipts');
const OUTPUTS_DIR    = path.resolve(ACC_ROOT, 'outputs/fetch-receipts');

const SUPPORTED_MIME = new Set([
  'application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
]);
const SUPPORTED_EXT  = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp']);

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
    mode:        'both',
    days:        30,
    maxMessages: 50,
    localDir:    process.env.RECEIPT_INBOX_DIR || null,
    query:       null,
    noOcr:       false,
    dryRun:      false,
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if      (a === '--mode')          opts.mode        = args[++i];
    else if (a === '--days')          opts.days        = parseInt(args[++i], 10) || 30;
    else if (a === '--max-messages')  opts.maxMessages = parseInt(args[++i], 10) || 50;
    else if (a === '--local-dir')     opts.localDir    = args[++i];
    else if (a === '--query')         opts.query       = args[++i];
    else if (a === '--no-ocr')        opts.noOcr       = true;
    else if (a === '--dry-run')       opts.dryRun      = true;
    i++;
  }
  return opts;
}

// ------------------------------------------------------------------ date helpers

/** テキストから YYYY-MM-DD を抽出する。見つからなければ null。 */
function extractDateFromText(text) {
  // YYYY-MM-DD / YYYY/MM/DD
  const m1 = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m1) {
    const [, y, mo, d] = m1;
    if (parseInt(y) >= 2000 && parseInt(mo) <= 12 && parseInt(d) <= 31) {
      return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
  }
  // YYYYMMDD
  const m2 = text.match(/(\d{4})(\d{2})(\d{2})/);
  if (m2) {
    const [, y, mo, d] = m2;
    if (parseInt(y) >= 2000 && parseInt(mo) <= 12 && parseInt(d) <= 31) {
      return `${y}-${mo}-${d}`;
    }
  }
  return null;
}

/** yyyymm 形式 (文字列) に変換する */
function toYyyyMm(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : todayJST().slice(0, 7);
}

/** 安全なファイル名へ変換 (path traversal 防止) */
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
}

/** 重複しないパスを生成する */
function uniquePath(dir, filename) {
  const ext  = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.resolve(dir, sanitizeFilename(filename));
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.resolve(dir, sanitizeFilename(`${base}-${++n}${ext}`));
  }
  return candidate;
}

/** mimeType の推定 */
function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.png': 'image/png', '.webp': 'image/webp' };
  return map[ext] || 'application/octet-stream';
}

// ------------------------------------------------------------------ local file scanner

/** ディレクトリを再帰スキャンして支援拡張子のファイルパスを返す */
function scanLocalDir(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.resolve(dir, e.name);
      if (e.isDirectory()) {
        results.push(...scanLocalDir(full));
      } else if (e.isFile() && SUPPORTED_EXT.has(path.extname(e.name).toLowerCase())) {
        results.push(full);
      }
    }
  } catch { /* skip unreadable */ }
  return results;
}

// ------------------------------------------------------------------ core processing

/**
 * 1 ファイルバッファを受け取り、配置・OCR・インデックス登録まで行う。
 * dryRun=true の場合は何も書き込まない。
 */
async function processFile({
  fileBuffer, mimeType, filename, dateHint, yyyymm,
  source, sourceMessageId, sourceFilePath, opts, stats,
}) {
  const targetDir = path.resolve(RECEIPTS_BASE, yyyymm);
  const prefix    = dateHint ? dateHint.replace(/-/g, '') : yyyymm.replace('-', '');
  const safeName  = sanitizeFilename(`${prefix}-${filename}`);

  // ローカル重複チェック: sourceFilePath で一意性を判定
  if (source === 'local' && sourceFilePath) {
    const dupKey = `local:${sourceFilePath}`;
    const existing = loadIndex().receipts.find(r => r.source_filepath === dupKey);
    if (existing) {
      console.log(`  スキップ(重複): ${filename}`);
      stats.skipped++;
      return null;
    }
  }

  const destPath  = uniquePath(targetDir, safeName);
  const relPath   = path.relative(ACC_ROOT, destPath).replace(/\\/g, '/');

  if (opts.dryRun) {
    console.log(`  [DRY RUN] 配置予定: ${relPath}`);
    stats.planned++;
    return null;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(destPath, fileBuffer);
  stats.saved++;
  console.log(`  配置: ${relPath}`);

  // OCR
  let ocrResult = null;
  if (!opts.noOcr) {
    try {
      ocrResult = await ocrReceipt(fileBuffer, mimeType);
      if (ocrResult.needs_review) stats.needsReview++;
    } catch (err) {
      process.stderr.write(`[warn] OCR 失敗: ${err.message}\n`);
      ocrResult = { vendor: null, amount: null, date: null, tax_amount: null,
                    registration_number: null, confidence: 0, needs_review: true, raw_text: '' };
      stats.needsReview++;
    }
  }

  // receipts-index 追記
  const entry = {
    id:                  `${sourceMessageId || 'local'}:${crypto.randomBytes(6).toString('hex')}`,
    saved_path:          relPath,
    source,
    source_message_id:   sourceMessageId || null,
    source_filepath:     sourceFilePath ? `local:${sourceFilePath}` : null,
    vendor:              ocrResult?.vendor              ?? null,
    amount:              ocrResult?.amount              ?? null,
    date:                ocrResult?.date                ?? dateHint ?? null,
    tax_amount:          ocrResult?.tax_amount          ?? null,
    registration_number: ocrResult?.registration_number ?? null,
    confidence:          ocrResult?.confidence          ?? null,
    needs_review:        ocrResult?.needs_review        ?? true,
    ocr_raw_text:        (ocrResult?.raw_text           ?? '').slice(0, 200),
    added_at:            toJSTISOString(),
  };
  addReceipts([entry]);
  stats.indexEntries.push(entry);
  return entry;
}

// ------------------------------------------------------------------ Gmail mode

async function fetchFromGmail(opts, stats) {
  if (!isConfigured()) {
    process.stderr.write('[warn] Gmail 認証情報が未設定のためスキップします。\n');
    return;
  }

  const after = new Date(Date.now() - opts.days * 86400000);
  const defaultQuery =
    'has:attachment (filename:pdf OR filename:jpg OR filename:jpeg OR filename:png) ' +
    '(領収書 OR 受領書 OR receipt OR レシート OR 請求書 OR インボイス)';
  const q = opts.query || defaultQuery;

  console.log(`Gmail 検索: "${q}" (${opts.days} 日分)`);
  let msgList;
  try {
    msgList = await searchMessages({ query: q, maxResults: opts.maxMessages, after });
  } catch (err) {
    process.stderr.write(`[error] Gmail 検索失敗: ${err.message}\n`);
    return;
  }
  console.log(`  メッセージ ${msgList.length} 件ヒット`);

  for (const { id } of msgList) {
    if (isProcessed(id)) {
      console.log(`  スキップ(処理済): ${id}`);
      stats.skippedGmail++;
      continue;
    }

    let msg;
    try { msg = await getMessage(id); }
    catch (err) {
      process.stderr.write(`[warn] getMessage 失敗 ${id}: ${err.message}\n`);
      continue;
    }

    const dateHint = extractDateFromText(msg.subject + ' ' + msg.body.text.slice(0, 500))
      || msg.date.toISOString().slice(0, 10);
    const yyyymm = toYyyyMm(dateHint);

    const receipts = msg.attachments.filter(a => SUPPORTED_MIME.has(a.mimeType));
    if (receipts.length === 0) {
      console.log(`  スキップ(添付なし): ${msg.subject}`);
      continue;
    }

    const savedPaths = [];
    const ocrResults = [];

    for (const att of receipts) {
      let buf;
      try { buf = await downloadAttachment(id, att.attachmentId); }
      catch (err) {
        process.stderr.write(`[warn] downloadAttachment 失敗: ${err.message}\n`);
        continue;
      }
      if (!buf) continue;

      const entry = await processFile({
        fileBuffer: buf, mimeType: att.mimeType, filename: att.filename,
        dateHint, yyyymm, source: 'gmail', sourceMessageId: id, opts, stats,
      });
      if (entry) {
        savedPaths.push(entry.saved_path);
        ocrResults.push({ filename: att.filename, ...entry });
      }
    }

    if (!opts.dryRun) {
      recordProcessed({
        messageId: id, subject: msg.subject, from: msg.from,
        attachments_count: receipts.length,
        saved_paths: savedPaths, ocr_results: ocrResults,
      });
    }
  }
}

// ------------------------------------------------------------------ Local mode

async function fetchFromLocal(opts, stats) {
  const localDir = opts.localDir;
  if (!localDir) {
    process.stderr.write('[warn] --local-dir が未指定、RECEIPT_INBOX_DIR も未設定です。ローカルモードをスキップ。\n');
    return;
  }
  if (!fs.existsSync(localDir)) {
    process.stderr.write(`[warn] ローカルディレクトリが存在しません: ${localDir}\n`);
    return;
  }

  const files = scanLocalDir(localDir);
  console.log(`ローカルスキャン: ${localDir} → ${files.length} ファイル`);

  for (const fp of files) {
    const filename = path.basename(fp);
    const mimeType = guessMime(filename);
    const dateHint = extractDateFromText(filename)
      || new Date(fs.statSync(fp).mtime).toISOString().slice(0, 10);
    const yyyymm = toYyyyMm(dateHint);

    const buf = fs.readFileSync(fp);
    await processFile({
      fileBuffer: buf, mimeType, filename, dateHint, yyyymm,
      source: 'local', sourceMessageId: null, sourceFilePath: fp, opts, stats,
    });
  }
}

// ------------------------------------------------------------------ output builders

function buildSummaryMd(opts, stats, today) {
  const lines = [
    `# 領収書取り込みサマリ (${today})`,
    '',
    '> ⚠️ OCR は AI 補助による出力。最終確認は人が行うこと。',
    '',
    `生成日時: ${tsLabel()}`,
    '',
    '## 概要',
    '',
    '| 項目 | 件数 |',
    '|---|---|',
    `| 配置完了 | ${stats.saved} |`,
    `| DRY RUN 予定 | ${stats.planned} |`,
    `| スキップ(既処理・重複) | ${stats.skipped + stats.skippedGmail} |`,
    `| OCR 要確認 | ${stats.needsReview} |`,
    '',
  ];

  if (stats.needsReview > 0 && stats.indexEntries.length > 0) {
    lines.push('## 要確認エントリ', '');
    lines.push('| ファイル | 信頼度 | 取引先 | 金額 |');
    lines.push('|---|---|---|---|');
    for (const e of stats.indexEntries.filter(e => e.needs_review).slice(0, 10)) {
      lines.push(`| ${e.saved_path} | ${e.confidence ?? '-'} | ${e.vendor ?? '不明'} | ${e.amount ?? '不明'} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*accounting/scripts/fetch-receipts.js により自動生成*');
  return lines.join('\n');
}

function buildSummaryCsvRows(stats) {
  return stats.indexEntries.map(e => ({
    '取得日時':   e.added_at || '',
    '配置パス':   e.saved_path,
    '取引先':     e.vendor              ?? '',
    '金額':       e.amount              ?? '',
    '取引日':     e.date                ?? '',
    '消費税':     e.tax_amount          ?? '',
    '登録番号':   e.registration_number ?? '',
    '信頼度':     e.confidence          ?? '',
    '要確認':     e.needs_review ? '要確認' : '',
    'ソース':     e.source,
  }));
}

// ------------------------------------------------------------------ main

async function main() {
  const opts  = parseArgs();
  const today = todayJST();

  console.log(`領収書自動取り込み: ${today} (mode=${opts.mode}, days=${opts.days})`);
  if (opts.dryRun) console.log('[DRY RUN] ファイル保存・state 更新はしません。');

  const stats = {
    saved: 0, planned: 0, skipped: 0, skippedGmail: 0,
    needsReview: 0, indexEntries: [],
  };

  if (opts.mode === 'gmail' || opts.mode === 'both') {
    await fetchFromGmail(opts, stats);
  }
  if (opts.mode === 'local' || opts.mode === 'both') {
    await fetchFromLocal(opts, stats);
  }

  if (opts.dryRun) {
    console.log(`\n[DRY RUN] 配置予定: ${stats.planned} 件`);
    return;
  }

  // 出力ファイル生成
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  const mdPath  = path.resolve(OUTPUTS_DIR, `${today}.md`);
  const csvPath = path.resolve(OUTPUTS_DIR, `${today}.csv`);
  fs.writeFileSync(mdPath, buildSummaryMd(opts, stats, today), 'utf8');
  writeCSV(buildSummaryCsvRows(stats), csvPath);

  console.log(`\n出力: ${mdPath}`);
  console.log(`      ${csvPath}`);
  console.log(`配置: ${stats.saved} 件 / スキップ: ${stats.skipped + stats.skippedGmail} 件 / 要確認: ${stats.needsReview} 件`);
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
