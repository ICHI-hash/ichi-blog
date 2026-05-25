/**
 * sales/leads/research.js
 * ICHI Web リサーチ営業 – STEP 2
 *
 * 使い方:
 *   node sales/leads/research.js --area "東京 吉祥寺" [--type cafe|salon|both] [--count N]
 *
 *   --area  : 検索する地域（必須）
 *   --type  : cafe | salon | both（省略時: both）
 *   --count : 1業態あたりの目安件数（省略時: 6）
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { askWithWebSearch } from '../lib/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI 引数パース ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { area: null, type: 'both', count: 6 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--area':  opts.area  = args[++i];                       break;
      case '--type':  opts.type  = args[++i];                       break;
      case '--count': opts.count = parseInt(args[++i], 10) || 6;   break;
    }
  }
  return opts;
}

// ── CSV ユーティリティ ─────────────────────────────────────────────────────

const CSV_FIELDS = [
  'name', 'category', 'area', 'summary', 'score', 'score_reason',
  'issue_hypothesis', 'contact_form_url', 'source_url', 'send',
];

/** RFC 4180 準拠: フィールドをダブルクォートで囲み、内部の " を "" にエスケープ */
function csvQ(val) {
  const s = String(val ?? '');
  return '"' + s.replace(/"/g, '""') + '"';
}

function toCsvRow(obj) {
  return CSV_FIELDS.map(f => csvQ(obj[f] ?? '')).join(',');
}

/** 1行の CSV をフィールド配列に分解（クォート・エスケープ対応） */
function parseCsvLine(line) {
  const cols = [];
  let inQ = false, cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"')                   { inQ = false; }
      else                                  { cur += c; }
    } else {
      if      (c === '"') { inQ = true; }
      else if (c === ',') { cols.push(cur); cur = ''; }
      else                { cur += c; }
    }
  }
  cols.push(cur);
  return cols;
}

// ── JSON 抽出 ──────────────────────────────────────────────────────────────

/**
 * rawResponse から <<<CANDIDATES_JSON>>> … <<<END>>> の中身を取り出して parse。
 * マーカーがなければ最後の [...] ブロックをフォールバックとして使う。
 */
function extractCandidates(raw) {
  // ① マーカー方式
  const m = raw.match(/<<<CANDIDATES_JSON>>>([\s\S]*?)<<<END>>>/);
  if (m) {
    try { return JSON.parse(m[1].trim()); } catch (_) { /* fall through */ }
  }
  // ② フォールバック: テキスト内の最後の [...] ブロック
  const allArrays = [...raw.matchAll(/\[[\s\S]*?\]/g)];
  if (allArrays.length > 0) {
    try { return JSON.parse(allArrays.at(-1)[0]); } catch (_) { /* fall through */ }
  }
  return null;
}

// ── メイン ─────────────────────────────────────────────────────────────────

async function main() {
  const { area, type, count } = parseArgs();

  if (!area) {
    console.error([
      '使い方: node sales/leads/research.js --area "地域名" [--type cafe|salon|both] [--count N]',
      '',
      '  --area  : 検索する地域（必須）例: "東京 吉祥寺"',
      '  --type  : cafe | salon | both（省略時: both）',
      '  --count : 1業態あたりの目安件数（省略時: 6）',
    ].join('\n'));
    process.exit(1);
  }

  // ── criteria.md 読み込み
  const criteriaPath = resolve(__dirname, './criteria.md');
  const criteria = readFileSync(criteriaPath, 'utf-8');

  // ── inputs/leads/*.md から追加ヒントを収集
  const hintsDir = resolve(__dirname, '../inputs/leads');
  let hintsBlock = '';
  if (existsSync(hintsDir)) {
    const mdFiles = readdirSync(hintsDir).filter(f => f.endsWith('.md'));
    if (mdFiles.length > 0) {
      hintsBlock =
        '\n\n---\n【追加の検索ヒント（inputs/leads より）】\n' +
        mdFiles
          .map(f => `### ${f}\n${readFileSync(resolve(hintsDir, f), 'utf-8')}`)
          .join('\n\n');
    }
  }

  // ── 業態ラベル
  const typeLabel =
    type === 'cafe'  ? 'カフェ・飲食店' :
    type === 'salon' ? '美容室・サロン・ネイルサロン' :
                      'カフェ・飲食店 および 美容室・サロン・ネイルサロン';

  // ── system プロンプト
  const system = `\
あなたは ICHI の営業リサーチ担当です。
以下の criteria.md の基準に従い、指定された地域の個人経営の店舗を web_search で実在ベースで調査してください。

===== criteria.md =====
${criteria}
=======================

【必須ルール】
1. チェーン・FC・大手資本は除外。個人経営（オーナー＝決裁者）のみを対象とする。
2. 各店舗に criteria.md のスコアリング基準（1〜5）でスコアを付ける。
3. web_search で実際に見つけた出典 URL が確認できない店舗は出力に含めない。URL の推測・捏造は絶対禁止。
4. contact_form_url は公式サイトに問い合わせフォームがあれば入力する。なければ空文字。個人のメールアドレスは絶対に入れない。
5. スクレイピングはしない。web_search で得た公開情報のみ使用する。
${hintsBlock}

【出力フォーマット（厳守）】
検索の過程はどのように記述しても構いません。
ただし、最後に必ず下記マーカーで挟んだ JSON 配列のみを出力してください。
・source_url が空の要素は絶対に含めない
・スコア降順で並べる
・マーカー内に JSON 以外の文字を入れない

<<<CANDIDATES_JSON>>>
[
  {
    "name": "店名",
    "category": "カフェ / 飲食店 / 美容室 / サロン / ネイルサロン のいずれか",
    "area": "地域",
    "summary": "公開情報ベースの概要（30〜80字）",
    "score": 1〜5の整数,
    "score_reason": "スコアの理由（criteria.md の基準に沿って）",
    "issue_hypothesis": "刺さりそうな『あるある業務』の仮説",
    "contact_form_url": "問い合わせフォームURL（なければ空文字）",
    "source_url": "出典URL（必須・web_search で見つけた根拠ページ）"
  }
]
<<<END>>>`;

  // ── user プロンプト
  const prompt = `\
【リサーチ条件】
- 対象地域: ${area}
- 対象業態: ${typeLabel}
- 目安件数: 1業態あたり最大 ${count} 件

上記の条件で web_search を使い、${area} にある個人経営の店舗を実在ベースでリサーチしてください。
criteria.md の基準に従ってスコアリングし、指定フォーマットの JSON を出力してください。`;

  // 件数に応じて検索回数を調整（最小6・最大20）
  const maxSearches = Math.min(Math.max(count * (type === 'both' ? 4 : 3), 6), 20);

  console.log(`\n🔍 リサーチ開始`);
  console.log(`   地域: ${area}  業態: ${type}  目安: ${count}件/業態  最大検索: ${maxSearches}回\n`);

  // ── API 呼び出し
  let raw;
  try {
    raw = await askWithWebSearch({
      system,
      prompt,
      maxSearches,
      maxTokens: 16000,
    });
  } catch (err) {
    console.error('❌ API エラー:', err.message);
    process.exit(1);
  }

  // ── JSON 抽出
  const parsed = extractCandidates(raw);
  if (!parsed || !Array.isArray(parsed)) {
    const rawPath = resolve(__dirname, '../outputs/leads/_last_research_raw.txt');
    writeFileSync(rawPath, raw, 'utf-8');
    console.error('❌ JSON のパースに失敗しました。');
    console.error(`   生レスポンスを保存しました: ${rawPath}`);
    console.error('   内容を確認してプロンプトやモデル設定を調整してください。');
    process.exit(1);
  }

  // ── コード側フィルタ（安全側）
  const beforeFilter = parsed.length;
  const valid = parsed.filter(c => {
    // source_url が http(s):// で始まらないものは除外（捏造・推測URL対策）
    if (!c.source_url || !String(c.source_url).startsWith('http')) return false;
    // score が 1〜5 の整数でなければ除外
    const s = Number(c.score);
    if (!Number.isInteger(s) || s < 1 || s > 5) return false;
    return true;
  });
  const filteredOut = beforeFilter - valid.length;

  // スコア降順ソート
  valid.sort((a, b) => Number(b.score) - Number(a.score));

  // ── CSV 書き出し
  const csvPath = resolve(__dirname, '../outputs/leads/candidates.csv');
  const BOM = '﻿';

  // 既存ファイルから source_url を収集して重複チェック
  const existingUrls = new Set();
  const csvExists = existsSync(csvPath);
  if (csvExists) {
    const raw = readFileSync(csvPath, 'utf-8').replace(/^﻿/, ''); // BOM 除去
    for (const line of raw.split('\n').slice(1)) { // ヘッダ行をスキップ
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      if (cols[8]) existingUrls.add(cols[8]); // source_url は index 8
    }
  }

  const newItems  = valid.filter(c => !existingUrls.has(c.source_url));
  const dupCount  = valid.length - newItems.length;

  // ヘッダ行（新規ファイル時のみ）
  if (!csvExists) {
    const headerLine = CSV_FIELDS.map(csvQ).join(',');
    writeFileSync(csvPath, BOM + headerLine + '\n', 'utf-8');
  }

  // データ行を追記
  if (newItems.length > 0) {
    appendFileSync(csvPath, newItems.map(toCsvRow).join('\n') + '\n', 'utf-8');
  }

  // ── 結果サマリ
  const highScore = newItems.filter(c => Number(c.score) >= 4).length;
  console.log(`✅ 新規 ${newItems.length} 件を追加（うちスコア4以上 ${highScore} 件）。除外 ${filteredOut} 件（出典URLなし等）。`);
  if (dupCount > 0) console.log(`   重複スキップ: ${dupCount} 件`);
  console.log(`   出力先: ${csvPath}`);
}

main().catch(err => {
  console.error('❌ 予期せぬエラー:', err);
  process.exit(1);
});
