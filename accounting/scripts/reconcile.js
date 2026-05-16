'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { parseTransactionsFromCSV, writeCSV } = require('../lib/csv');
const { runPrompt }                           = require('../lib/claude');
const { loadAllInvoices, filterUnreconciled } = require('../lib/invoice-index');
const { loadReconciled, recordMatch }         = require('../lib/reconcile-state');
const { normalizeName, jaroWinkler }          = require('../lib/string-similarity');
const { formatJPY }                           = require('../lib/money');

const ACC_ROOT    = path.resolve(__dirname, '..');
const OUTPUTS_DIR = path.resolve(ACC_ROOT, 'outputs/reconcile');

// ------------------------------------------------------------------ JST helpers

function toJSTISOString() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}
function tsLabel() {
  const s = toJSTISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
}

// ------------------------------------------------------------------ date math

// "YYYY-MM-DD" → Date (JST 0:00)
function parseDate(str) {
  return new Date(str + 'T00:00:00+09:00');
}

// later - earlier in days (rounded)
function diffDays(laterStr, earlierStr) {
  return Math.round((parseDate(laterStr) - parseDate(earlierStr)) / 86400000);
}

// "YYYY-MM-DD" + n days → "YYYY-MM-DD"
function addDays(dateStr, n) {
  const d = new Date(parseDate(dateStr).getTime() + n * 86400000);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ hash

function computeDepositHash(tx) {
  const desc = String(tx.description || '').trim().replace(/\s+/g, ' ');
  const key  = `${tx.date}|${desc}|${tx.amount}`;
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------ CLI

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    inputPath:    null,
    format:       null,
    encoding:     'utf8',
    manualMapping: null,
    feeTolerance: 1000,
    daysWindow:   60,
    minScore:     0.5,
    confirm:      false,
    dryRun:       false,
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--format')            opts.format       = args[++i];
    else if (a === '--encoding')     opts.encoding      = args[++i];
    else if (a === '--manual-mapping') opts.manualMapping = args[++i];
    else if (a === '--fee-tolerance')  opts.feeTolerance = parseInt(args[++i], 10) || 1000;
    else if (a === '--days-window')    opts.daysWindow   = parseInt(args[++i], 10) || 60;
    else if (a === '--min-score')      opts.minScore     = parseFloat(args[++i]) || 0.5;
    else if (a === '--confirm')      opts.confirm      = true;
    else if (a === '--dry-run')      opts.dryRun       = true;
    else if (!a.startsWith('--'))    opts.inputPath    = a;
    i++;
  }
  return opts;
}

// ------------------------------------------------------------------ matching

/**
 * 単一の (deposit, invoice) ペアをスコアリングする。
 * 金額・日付フィルタを通らなければ null を返す。
 */
function scoreCandidate(deposit, invoice, opts) {
  const { feeTolerance, daysWindow } = opts;

  // 金額スコア
  let amountScore;
  const diff = invoice.billed_amount - deposit.depositAmount;
  if (diff === 0) {
    amountScore = 1.0;
  } else if (diff > 0 && diff <= feeTolerance) {
    amountScore = 0.85;
  } else {
    return null;
  }

  // 日付フィルタ: issue_date 以降 ~ issue_date + daysWindow 日以内
  const elapsed = diffDays(deposit.date, invoice.issue_date);
  if (elapsed < 0 || elapsed > daysWindow) return null;

  // 名称スコア
  const normDep    = normalizeName(deposit.description);
  const normClient = normalizeName(invoice.client_name);
  const nameScore  = jaroWinkler(normDep, normClient);

  // 日付スコア (0..1)
  const dateScore = Math.max(0, 1 - elapsed / daysWindow);

  const totalScore = 0.5 * amountScore + 0.35 * nameScore + 0.15 * dateScore;

  return {
    invoice,
    amountScore,
    nameScore,
    dateScore,
    totalScore,
    elapsed,
    amountExact: diff === 0,
    aiReason:    null,
    aiScore:     null,
  };
}

// ------------------------------------------------------------------ AI review

/**
 * total_score >= 0.6 かつ name_score < 0.7 の候補について Claude でブースト。
 * 最大 20 ペアまとめて送信。失敗しても全体は止めない。
 */
async function aiReviewCandidates(reviewPairs) {
  if (reviewPairs.length === 0) return;

  process.stderr.write(`[info] AI 補助レビュー開始: ${reviewPairs.length} ペアを Claude API に送信中...\n`);

  const system = `あなたは日本のフリーランス事業者の入金消込を補助する AI です。
銀行振込時の振込人名は短縮・カナ表記・部署名混入などで請求先の正式名と
表記が大きく異なることがあります。
以下の候補ペアそれぞれについて、同一企業からの振込である可能性を
0.0〜1.0 で評価し、必ず以下のフォーマットで JSON 配列のみを返してください。
前置きや説明文は一切含めないこと。

出力フォーマット(厳守):
[
  { "id": "入力と同じ id", "same_entity": 0.92, "reason": "判断理由(50文字以内)" }
]`;

  const user = JSON.stringify(
    reviewPairs.map(p => ({
      id:                  p.id,
      deposit_description: p.depositDescription,
      client_name:         p.clientName,
    })),
    null, 2
  );

  let parsed = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text    = await runPrompt({ system, user, maxTokens: 2048 });
      const cleaned = text
        .replace(/^```(?:json)?\s*\r?\n?/m, '')
        .replace(/\r?\n?```\s*$/m, '')
        .trim();
      const result = JSON.parse(cleaned);
      if (!Array.isArray(result)) throw new Error('配列が期待されます');
      parsed = result;
      break;
    } catch (err) {
      process.stderr.write(`[warn] AI レビュー attempt ${attempt} 失敗: ${err.message}\n`);
    }
  }

  if (!parsed) {
    process.stderr.write('[warn] AI レビューをスキップします (2 回失敗)。\n');
    return;
  }

  for (const result of parsed) {
    const pair = reviewPairs.find(p => p.id === result.id);
    // same_entity が優先、フォールバックとして score も受け付ける
    const sameEntity = result.same_entity ?? result.score ?? null;
    if (!pair || typeof sameEntity !== 'number') continue;
    result.same_entity = sameEntity;

    const boost = (result.same_entity - 0.5) * 0.3; // -0.15 ~ +0.15
    pair.candidate.nameScore  = Math.min(1, Math.max(0, pair.candidate.nameScore + boost));
    pair.candidate.aiReason   = String(result.reason || '');
    pair.candidate.aiScore    = result.same_entity;
    // 総合スコアを再計算
    pair.candidate.totalScore =
      0.5  * pair.candidate.amountScore
    + 0.35 * pair.candidate.nameScore
    + 0.15 * pair.candidate.dateScore;

    process.stderr.write(
      `[info] AI ブースト: ${pair.depositDescription} / ${pair.clientName}` +
      ` → same_entity=${result.same_entity.toFixed(2)} boost=${boost.toFixed(3)}` +
      ` new name_score=${pair.candidate.nameScore.toFixed(3)}\n`
    );
  }
}

// ------------------------------------------------------------------ auto-confirm check

function isAutoConfirmable(candidate) {
  return (
    candidate.totalScore  >= 0.95 &&
    candidate.amountScore === 1.0  &&
    candidate.nameScore   >= 0.85
  );
}

// ------------------------------------------------------------------ output: proposals.md

function buildProposalsMd({
  inputBase, inputPath, detectedFormat,
  depositResults, unmatchedDeposits,
  confirmedCount, dryRun,
}) {
  const autoConfirmCount = depositResults
    .flatMap(r => r.candidates)
    .filter((c, idx, arr) => idx === arr.findIndex(x => x === c) && isAutoConfirmable(c))
    .length;

  const lines = [
    '> ⚠️ **AI 補助による入金消込の提案です。自動確定は補助手段であり、最終消込判断は人が行ってください。**',
    '',
    `生成日時: ${tsLabel()}${dryRun ? '　[DRY RUN]' : ''}`,
    '',
    '---',
    '',
    '## 概要',
    '',
    '| 項目 | 値 |',
    '|---|---|',
    `| 入力 CSV | ${inputPath} |`,
    `| 検出形式 | ${detectedFormat} |`,
    `| 入金件数 | ${depositResults.length + unmatchedDeposits.length} |`,
    `| マッチ候補あり | ${depositResults.length} |`,
    `| 未マッチ入金 | ${unmatchedDeposits.length} |`,
    `| 自動確定対象 | ${autoConfirmCount} |`,
    confirmedCount > 0 ? `| 今回確定 | ${confirmedCount} |` : null,
    '',
    '---',
    '',
    '## 入金マッチング提案',
    '',
  ].filter(l => l !== null);

  for (const result of depositResults) {
    const dep = result.deposit;
    lines.push(`### 入金 ${dep.date} ${formatJPY(dep.depositAmount)} 「${dep.description}」`);
    lines.push('');

    result.candidates.forEach((c, i) => {
      const inv = c.invoice;
      const amountMark = c.amountExact ? '✓ 完全一致' : `手数料控除後一致 (差額 ${formatJPY(inv.billed_amount - dep.depositAmount)})`;
      const confirmMark = isAutoConfirmable(c) ? '　**[自動確定対象]**' : '';
      const aiNote = c.aiReason ? `　AI評価: ${c.aiScore.toFixed(2)} (${c.aiReason})` : '';
      lines.push(`- **候補${i + 1}**: ${inv.invoice_number} ${inv.client_name}様 (${formatJPY(inv.billed_amount)}, 発行日${inv.issue_date})`);
      lines.push(`  - 総合スコア ${c.totalScore.toFixed(3)} / 金額: ${amountMark} / 名称類似: ${c.nameScore.toFixed(3)} / 経過: ${c.elapsed} 日${confirmMark}`);
      if (aiNote) lines.push(`  - ${aiNote}`);
    });
    lines.push('');
  }

  if (unmatchedDeposits.length > 0) {
    lines.push('---', '', '## 未マッチ入金', '');
    lines.push('| 日付 | 入金額 | 摘要 |');
    lines.push('|---|---|---|');
    for (const dep of unmatchedDeposits) {
      lines.push(`| ${dep.date} | ${formatJPY(dep.depositAmount)} | ${dep.description} |`);
    }
    lines.push('');
  }

  lines.push('---', '');
  lines.push('*このファイルは accounting/scripts/reconcile.js により自動生成されました。*');

  return lines.join('\n');
}

// ------------------------------------------------------------------ output: unmatched-invoices.md

function buildUnmatchedInvoicesMd({
  inputBase, periodStart, periodEnd,
  unmatchedInPeriod, unmatchedOld, today,
}) {
  const lines = [
    '> ⚠️ **未消込請求書一覧。期日超過分は早急に確認してください。**',
    '',
    `生成日時: ${tsLabel()}`,
    `入金 CSV 対象期間: ${periodStart} 〜 ${periodEnd}`,
    '',
    '---',
    '',
    '## 未消込請求書（入力期間内）',
    '',
    '| 請求書番号 | 顧客名 | 請求額 | 発行日 | 支払期日 | 状態 |',
    '|---|---|---|---|---|---|',
  ];

  if (unmatchedInPeriod.length === 0) {
    lines.push('| (なし) | | | | | |');
  } else {
    for (const inv of unmatchedInPeriod) {
      const overdue = inv.due_date < today ? '⚠️ 期日超過' : '未入金';
      lines.push(`| ${inv.invoice_number} | ${inv.client_name} | ${formatJPY(inv.billed_amount)} | ${inv.issue_date} | ${inv.due_date} | ${overdue} |`);
    }
  }

  lines.push('');

  if (unmatchedOld.length > 0) {
    lines.push('---', '', '## 参考: 期間外の古い未消込請求書', '');
    lines.push('| 請求書番号 | 顧客名 | 請求額 | 発行日 | 支払期日 | 状態 |');
    lines.push('|---|---|---|---|---|---|');
    for (const inv of unmatchedOld) {
      const overdue = inv.due_date < today ? '⚠️ 期日超過' : '未入金';
      lines.push(`| ${inv.invoice_number} | ${inv.client_name} | ${formatJPY(inv.billed_amount)} | ${inv.issue_date} | ${inv.due_date} | ${overdue} |`);
    }
    lines.push('');
  }

  lines.push('---', '');
  lines.push('*このファイルは accounting/scripts/reconcile.js により自動生成されました。*');
  return lines.join('\n');
}

// ------------------------------------------------------------------ output: proposals.csv

function buildProposalsCsvRows(depositResults, unmatchedDeposits) {
  const rows = [];
  for (const result of depositResults) {
    const dep = result.deposit;
    result.candidates.forEach((c, i) => {
      const inv = c.invoice;
      rows.push({
        '入金日':     dep.date,
        '入金額':     dep.depositAmount,
        '摘要':       dep.description,
        '請求書番号': inv.invoice_number,
        '顧客名':     inv.client_name,
        '請求額':     inv.billed_amount,
        '総合スコア': c.totalScore.toFixed(4),
        '金額一致':   c.amountExact ? '完全' : '手数料控除後',
        '名称類似':   c.nameScore.toFixed(4),
        '経過日数':   c.elapsed,
        '自動確定':   isAutoConfirmable(c) ? '○' : '',
        '備考':       c.aiReason || '',
      });
    });
  }
  for (const dep of unmatchedDeposits) {
    rows.push({
      '入金日':     dep.date,
      '入金額':     dep.depositAmount,
      '摘要':       dep.description,
      '請求書番号': '',
      '顧客名':     '',
      '請求額':     '',
      '総合スコア': '',
      '金額一致':   '',
      '名称類似':   '',
      '経過日数':   '',
      '自動確定':   '',
      '備考':       '未マッチ',
    });
  }
  return rows;
}

// ------------------------------------------------------------------ main

async function main() {
  const opts = parseArgs();
  const { inputPath, format, encoding, feeTolerance, daysWindow, minScore, confirm, dryRun } = opts;

  if (!inputPath) {
    process.stderr.write('使い方: node accounting/scripts/reconcile.js <CSV パス> [オプション]\n');
    process.stderr.write('  --format moneyforward|freee|mufg|manual\n');
    process.stderr.write('  --encoding utf8|sjis\n');
    process.stderr.write('  --fee-tolerance <円>   デフォルト 1000\n');
    process.stderr.write('  --days-window <日数>   デフォルト 60\n');
    process.stderr.write('  --min-score <0..1>     デフォルト 0.5\n');
    process.stderr.write('  --confirm              自動確定条件を満たすマッチを reconciled.json に記録\n');
    process.stderr.write('  --dry-run              何も書き込まず提案のみ表示\n');
    process.exit(1);
  }

  const absInput = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(absInput)) {
    process.stderr.write(`ファイルが見つかりません: ${absInput}\n`);
    process.exit(1);
  }

  // manual-mapping
  let manualMapping = null;
  if (opts.manualMapping) {
    manualMapping = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), opts.manualMapping), 'utf8'));
  }

  // 1. CSV パース
  console.log(`CSV 読み込み中: ${absInput}`);
  const { format: detectedFormat, transactions: allTx } = parseTransactionsFromCSV(absInput, {
    encoding: encoding === 'sjis' ? 'sjis' : undefined,
    format:   format || undefined,
    manualMapping,
  });
  console.log(`  検出形式: ${detectedFormat} / 総トランザクション: ${allTx.length} 件`);

  // 2. 入金のみ抽出 (amount < 0 → 正の depositAmount に反転)
  const deposits = allTx
    .filter(tx => tx.amount < 0)
    .map(tx => ({
      ...tx,
      depositAmount: -tx.amount,
      hash: computeDepositHash(tx),
    }));
  const expenseCount = allTx.length - deposits.length;
  console.log(`  入金: ${deposits.length} 件 / 支払・除外: ${expenseCount} 件`);

  if (deposits.length === 0) {
    console.log('入金トランザクションが見つかりません。処理を終了します。');
    return;
  }

  // 3. 未消込請求書一覧
  const reconciledData  = loadReconciled();
  const allInvoices     = loadAllInvoices();
  const pendingInvoices = filterUnreconciled(allInvoices, reconciledData);
  console.log(`  未消込請求書: ${pendingInvoices.length} 件 / 全請求書: ${allInvoices.length} 件`);

  if (pendingInvoices.length === 0) {
    console.log('未消込請求書がありません。処理を終了します。');
    return;
  }

  // 4. 各入金に対して候補マッチング + スコアリング
  const depositResults    = []; // { deposit, candidates[] }
  const unmatchedDeposits = [];
  const aiReviewPairs     = []; // AI に送る候補ペア

  for (const dep of deposits) {
    const candidates = [];

    for (const inv of pendingInvoices) {
      const scored = scoreCandidate(dep, inv, opts);
      if (!scored) continue;
      if (scored.totalScore < minScore) continue;
      candidates.push(scored);
    }

    // 総合スコア降順、上位 3 件
    candidates.sort((a, b) => b.totalScore - a.totalScore);
    const top3 = candidates.slice(0, 3);

    if (top3.length === 0) {
      unmatchedDeposits.push(dep);
      continue;
    }

    depositResults.push({ deposit: dep, candidates: top3 });

    // AI レビュー対象を収集 (total >= 0.6 かつ name_score < 0.7、最大 20 ペアまで)
    for (const c of top3) {
      if (aiReviewPairs.length < 20 && c.totalScore >= 0.6 && c.nameScore < 0.7) {
        aiReviewPairs.push({
          id:                 `${dep.hash}_${c.invoice.invoice_number}`,
          depositDescription: dep.description,
          clientName:         c.invoice.client_name,
          candidate:          c,
        });
      }
    }
  }

  console.log(`  マッチ候補あり: ${depositResults.length} 件 / 未マッチ: ${unmatchedDeposits.length} 件`);
  console.log(`  AI レビュー対象: ${aiReviewPairs.length} ペア`);

  // 5. AI 補助レビュー
  if (aiReviewPairs.length > 0) {
    await aiReviewCandidates(aiReviewPairs);
    // AI ブースト後に再ソート
    for (const result of depositResults) {
      result.candidates.sort((a, b) => b.totalScore - a.totalScore);
    }
  }

  // 6. 未消込請求書分類（入力期間内 vs 期間外）
  const allDepDates = deposits.map(d => d.date).sort();
  const periodStart = allDepDates[0];
  const periodEnd   = addDays(allDepDates[allDepDates.length - 1], 14);
  const today       = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  // 今回の提案に登場した請求書番号セット
  const proposedInvoiceNums = new Set(
    depositResults.flatMap(r => r.candidates.map(c => c.invoice.invoice_number))
  );

  const unmatchedInvoices = pendingInvoices.filter(inv => !proposedInvoiceNums.has(inv.invoice_number));
  const unmatchedInPeriod = unmatchedInvoices.filter(inv =>
    inv.issue_date >= periodStart && inv.issue_date <= periodEnd
  );
  const unmatchedOld = unmatchedInvoices.filter(inv =>
    inv.issue_date < periodStart || inv.issue_date > periodEnd
  );

  // dry-run: コンソール出力のみ
  if (dryRun) {
    console.log('\n[DRY RUN] 入金マッチング提案:');
    for (const result of depositResults) {
      const dep = result.deposit;
      console.log(`  入金 ${dep.date} ${formatJPY(dep.depositAmount)} 「${dep.description}」`);
      result.candidates.forEach((c, i) => {
        console.log(`    候補${i + 1}: ${c.invoice.invoice_number} ${c.invoice.client_name} total=${c.totalScore.toFixed(3)} ${isAutoConfirmable(c) ? '[自動確定対象]' : ''}`);
      });
    }
    if (unmatchedDeposits.length > 0) {
      console.log('  未マッチ入金:');
      unmatchedDeposits.forEach(d => console.log(`    ${d.date} ${formatJPY(d.depositAmount)} ${d.description}`));
    }
    console.log('\n[DRY RUN] state ファイルは更新しません。');
    return;
  }

  // 7. --confirm: 自動確定条件を満たすものを reconciled.json に書き込む
  let confirmedCount = 0;
  if (confirm) {
    for (const result of depositResults) {
      const dep  = result.deposit;
      const best = result.candidates[0];
      if (!isAutoConfirmable(best)) continue;

      const added = recordMatch({
        invoice_number:   best.invoice.invoice_number,
        transaction_hash: dep.hash,
        matched_amount:   dep.depositAmount,
        matched_at:       toJSTISOString(),
        method:           'auto',
        note:             `total_score=${best.totalScore.toFixed(4)} amount=${best.amountExact ? '完全' : '手数料控除後'} name=${best.nameScore.toFixed(4)}`,
      });
      if (added) {
        confirmedCount++;
        console.log(`  自動確定: ${best.invoice.invoice_number} ← ${dep.date} ${formatJPY(dep.depositAmount)} (score ${best.totalScore.toFixed(3)})`);
      }
    }
    console.log(`\n自動確定: ${confirmedCount} 件を reconciled.json に記録しました。`);
  }

  // 8. 出力ファイル生成
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  const inputBase = path.basename(absInput, '.csv');

  const proposalsMdPath   = path.resolve(OUTPUTS_DIR, `${inputBase}.proposals.md`);
  const unmatchedMdPath   = path.resolve(OUTPUTS_DIR, `${inputBase}.unmatched-invoices.md`);
  const proposalsCsvPath  = path.resolve(OUTPUTS_DIR, `${inputBase}.proposals.csv`);

  const proposalsMd = buildProposalsMd({
    inputBase, inputPath: absInput, detectedFormat,
    depositResults, unmatchedDeposits,
    confirmedCount, dryRun,
  });

  const unmatchedMd = buildUnmatchedInvoicesMd({
    inputBase, periodStart, periodEnd,
    unmatchedInPeriod, unmatchedOld, today,
  });

  const csvRows = buildProposalsCsvRows(depositResults, unmatchedDeposits);

  fs.writeFileSync(proposalsMdPath, proposalsMd, 'utf8');
  fs.writeFileSync(unmatchedMdPath, unmatchedMd, 'utf8');
  writeCSV(csvRows, proposalsCsvPath);

  console.log('\n出力ファイル:');
  console.log(`  proposals.md:         ${proposalsMdPath}`);
  console.log(`  unmatched-invoices.md:${unmatchedMdPath}`);
  console.log(`  proposals.csv:        ${proposalsCsvPath}`);

  // 自動確定対象の集計
  const autoCount = depositResults
    .filter(r => isAutoConfirmable(r.candidates[0]))
    .length;
  if (autoCount > 0 && !confirm) {
    console.log(`\n  自動確定対象: ${autoCount} 件 (--confirm を付けて再実行すると記録されます)`);
  }
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
