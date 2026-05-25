/**
 * sales/leads/draft.js
 * ICHI Web リサーチ営業 – STEP 4
 *
 * candidates.csv の send 列に印のある行を対象に、
 * 問い合わせフォーム投稿用の下書きを 1 店 1 ファイルで生成する。
 *
 * 使い方:
 *   node sales/leads/draft.js
 *
 * 事前に candidates.csv の send 列に ○（または任意のテキスト）を入力しておくこと。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { callClaude } from '../lib/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CSV パーサ ─────────────────────────────────────────────────────────────
// BOM 付き・全フィールドダブルクォート・"" エスケープ・フィールド内改行に対応

/**
 * CSV テキストを [[field, ...], ...] の二次元配列に変換する。
 * ・先頭の UTF-8 BOM（﻿）を除去してから処理する。
 * ・クォート内のカンマ・改行・"" エスケープを正しく扱う。
 */
function parseCsv(text) {
  const src = text.replace(/^﻿/, ''); // BOM 除去
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  let i = 0;

  const flush = () => { row.push(field); field = ''; };
  const newRow = () => { flush(); if (row.some(f => f !== '')) rows.push(row); row = []; };

  while (i < src.length) {
    const c = src[i];
    if (inQ) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 2; }       // "" → "
      else if (c === '"')                  { inQ = false; i++; }            // 閉じクォート
      else                                 { field += c; i++; }             // 通常文字（改行含む）
    } else {
      if      (c === '"')  { inQ = true; i++; }                             // 開きクォート
      else if (c === ',')  { flush(); i++; }                                // フィールド区切り
      else if (c === '\r' && src[i + 1] === '\n') { newRow(); i += 2; }    // CRLF
      else if (c === '\r' || c === '\n')           { newRow(); i++; }       // CR / LF
      else                                         { field += c; i++; }
    }
  }
  // ファイル末尾の最終行
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some(f => f !== '')) rows.push(row);
  }

  return rows;
}

// ── ファイル名サニタイズ ───────────────────────────────────────────────────

/** OS で使えない文字（/ \ : * ? " < > | と空白）を _ に置換する */
function safeFilename(name) {
  return name
    .replace(/[/\\:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** draftsDir 内でユニークなファイルパスを返す（衝突時は _2, _3, … を付与） */
function uniquePath(draftsDir, base) {
  let candidate = resolve(draftsDir, `${base}.md`);
  let n = 1;
  while (existsSync(candidate)) {
    n++;
    candidate = resolve(draftsDir, `${base}_${n}.md`);
  }
  return candidate;
}

// ── 下書きマーカー抽出 ────────────────────────────────────────────────────

/** <<<DRAFT>>> … <<<END>>> の間を取り出す。なければ全文をそのまま返す。 */
function extractDraft(raw) {
  const m = raw.match(/<<<DRAFT>>>([\s\S]*?)<<<END>>>/);
  return m ? m[1].trim() : raw.trim();
}

// ── system プロンプト生成 ──────────────────────────────────────────────────

function buildSystem(criteria) {
  return `\
あなたは ICHI の営業担当者です。
個人経営店の公式問い合わせフォームに人間が手で貼り付けるための下書きを生成します。

===== criteria.md =====
${criteria}
=======================

【生成方針】
1. criteria.md の「アプローチの訴求軸」と「下書きのトーン」に厳密に従う。
   - 売り込み臭を抑え、相手の負担への共感から書き始める。
   - AI・API・自動化・システム・ツール等の技術用語を一切使わない。日常語だけで書く。
   - 「小さく試せる（まず1つの作業だけ）」「5万円〜」「現場の忙しさへの理解」「オーナーの時間を取り戻す」を自然に盛り込む。
   - 心理的ハードルの低い CTA にする（例: 無料で一度お話を伺えれば、まず1つだけ試してみませんか 等）。
   - 本文は 300〜400 字程度。これ以上長くしない。
2. その店の「刺さりそうな課題仮説」に沿って、本文を1店ごとにカスタマイズする。一般論で終わらせない。
3. 誇大表現・実績の捏造をしない。ICHI は実績ゼロの個人事業者。正直で誠実なトーンにする。
4. 件名は 20 字程度。フォームに件名欄がない場合もあるので簡潔に。

【出力フォーマット（厳守）】
前置き・解説・余分な文章を付けず、以下のマーカーで挟んだ内容だけを出力する。

<<<DRAFT>>>
件名: （20字程度）
---
（本文 300〜400字）
<<<END>>>`;
}

// ── API 呼び出し（リトライ付き）─────────────────────────────────────────────

/**
 * callClaude を最大 maxRetries 回リトライする。
 * 429 Rate Limit の場合のみリトライし、それ以外のエラーはそのまま投げる。
 */
async function callClaudeWithRetry({ system, user, maxTokens }, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callClaude({ system, user, maxTokens });
    } catch (err) {
      const isRateLimit = err.status === 429 ||
        (err.message && err.message.includes('rate_limit'));
      if (isRateLimit && attempt < maxRetries) {
        const waitSec = attempt * 35; // 35s → 70s
        console.log(`   ⏳ レート制限のため ${waitSec} 秒待機してリトライします (${attempt}/${maxRetries - 1})...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
      } else {
        throw err;
      }
    }
  }
}

// ── メイン ─────────────────────────────────────────────────────────────────

async function main() {
  // candidates.csv を読む
  const csvPath = resolve(__dirname, '../outputs/leads/candidates.csv');
  if (!existsSync(csvPath)) {
    console.error('❌ candidates.csv が見つかりません。先に npm run research を実行してください。');
    console.error(`   期待するパス: ${csvPath}`);
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(csvPath, 'utf-8'));
  if (rows.length < 2) {
    console.error('❌ candidates.csv にデータ行がありません。');
    process.exit(1);
  }

  // ヘッダからフィールド名と index の対応表を作る
  const header = rows[0].map(h => h.trim());
  const col = (name) => header.indexOf(name);

  const iName        = col('name');
  const iCategory    = col('category');
  const iArea        = col('area');
  const iSummary     = col('summary');
  const iHypothesis  = col('issue_hypothesis');
  const iFormUrl     = col('contact_form_url');
  const iSourceUrl   = col('source_url');
  const iSend        = col('send');

  if ([iName, iSend].includes(-1)) {
    console.error('❌ CSV のヘッダに name / send 列が見つかりません。ファイルが壊れている可能性があります。');
    process.exit(1);
  }

  // send 列に値がある行だけ抽出
  const dataRows = rows.slice(1);
  const targets = dataRows.filter(r => {
    const sendVal = (r[iSend] ?? '').trim();
    return sendVal !== '';
  });

  if (targets.length === 0) {
    console.log('送信対象（send 列に印のある行）がありません。candidates.csv の send 列に ○ を入れてください。');
    process.exit(0);
  }

  console.log(`\n📝 下書き生成開始: ${targets.length} 件\n`);

  // criteria.md を読む
  const criteria = readFileSync(resolve(__dirname, './criteria.md'), 'utf-8');
  const system = buildSystem(criteria);

  // drafts ディレクトリを確保
  const draftsDir = resolve(__dirname, '../outputs/leads/drafts');
  if (!existsSync(draftsDir)) mkdirSync(draftsDir, { recursive: true });

  const generatedFiles = [];
  const noFormUrlShops = [];

  for (const row of targets) {
    const name           = row[iName]       ?? '';
    const category       = row[iCategory]   ?? '';
    const area           = row[iArea]       ?? '';
    const summary        = row[iSummary]    ?? '';
    const hypothesis     = row[iHypothesis] ?? '';
    const contactFormUrl = row[iFormUrl]    ?? '';
    const sourceUrl      = row[iSourceUrl]  ?? '';

    // 1店ぶんのプロンプト
    const user = `\
【対象店舗情報】
- 店名: ${name}
- 業態: ${category}
- 地域: ${area}
- 概要: ${summary}
- 刺さりそうな課題仮説: ${hypothesis}
- 問い合わせフォーム URL: ${contactFormUrl || '（未取得）'}
- 出典 URL: ${sourceUrl}

上記の店舗に向けた問い合わせフォームの下書きを生成してください。
この店の「${hypothesis}」という課題仮説に沿ってカスタマイズしてください。
本文は 300〜400 字で収めてください。`;

    let raw;
    try {
      raw = await callClaudeWithRetry({ system, user, maxTokens: 1200 });
    } catch (err) {
      console.error(`  ❌ ${name}: API エラー: ${err.message}`);
      continue;
    }

    // 連続リクエスト時のレート制限を緩和するため、店間に短い待機を挿入
    if (targets.indexOf(row) < targets.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }

    const draftContent = extractDraft(raw);

    // ファイルパスを確定
    const safeName = safeFilename(name);
    const filePath = uniquePath(draftsDir, safeName);
    const filename = filePath.split(/[/\\]/).at(-1);

    // Markdown 本文を組み立てる
    const formUrlDisplay = contactFormUrl
      ? contactFormUrl
      : '（未取得・人間が確認して記入）';

    const md = `# ${name} 宛 問い合わせフォーム下書き

- 業態: ${category}
- 地域: ${area}
- 投稿先フォーム URL: ${formUrlDisplay}
- 出典 URL: ${sourceUrl}
- 課題仮説: ${hypothesis}

> 注意: この下書きは人間が内容を確認し、上記フォーム URL に手動で貼り付けて送信すること。自動送信はしない。

---

${draftContent}
`;

    writeFileSync(filePath, md, 'utf-8');
    generatedFiles.push({ name, filename });

    // 字数を計測して表示
    // draftContent から本文部分（件名行と区切り行を除く）を取り出して字数確認
    const bodyLines = draftContent.split('\n').filter(l => !l.startsWith('件名:') && l !== '---');
    const bodyText  = bodyLines.join('').replace(/\s/g, '');
    const charCount = bodyText.length;

    console.log(`  ✅ ${name} → ${filename}（本文約 ${charCount} 字）`);

    if (!contactFormUrl) noFormUrlShops.push(name);
  }

  // 完了サマリ
  console.log(`\n✅ ${generatedFiles.length} 件の下書きを生成しました。`);
  console.log(`   保存先: ${draftsDir}\n`);

  if (noFormUrlShops.length > 0) {
    console.log('⚠️  フォーム URL 未取得（送信前に人間が確認・補記してください）:');
    noFormUrlShops.forEach(n => console.log(`   - フォーム URL 未取得: ${n}`));
  }
}

main().catch(err => {
  console.error('❌ 予期せぬエラー:', err);
  process.exit(1);
});
