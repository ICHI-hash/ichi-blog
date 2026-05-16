'use strict';
const path = require('path');

// ------------------------------------------------------------------ date helpers

function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function toJSTISOString() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00');
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ YAML helpers

function yamlString(val) {
  if (val === null || val === undefined) return 'null';
  const s = String(val);
  if (s.includes('\n')) {
    const indented = s.trimEnd().split('\n').map(l => '  ' + l).join('\n');
    return `|\n${indented}`;
  }
  if (/[:#\[\]{}&*!|>'"@`%]/.test(s) || s.trim() !== s) return JSON.stringify(s);
  return s;
}

function buildItemsYaml(items) {
  return items.map(item => {
    const name  = item.name       ? `\n    name: ${yamlString(item.name)}` : '';
    const qty   = `\n    qty: ${item.qty ?? 1}`;
    const price = `\n    unit_price: ${item.unit_price ?? 'null    # ← 要入力'}`;
    const rate  = `\n    tax_rate: ${item.tax_rate ?? 10}`;
    return `  -${name}${qty}${price}${rate}`;
  }).join('\n');
}

function buildFrontmatter(fields, items) {
  const lines = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${yamlString(v)}`);
  }
  if (items && items.length > 0) {
    lines.push('items:');
    lines.push(buildItemsYaml(items));
  }
  return `---\n${lines.join('\n')}\n---`;
}

// ------------------------------------------------------------------ AI completion

const AI_SYSTEM = `あなたは ICHI の経理補助 AI です。
営業案件情報から、請求書の品目名と支払条件文を日本語のビジネス文書として
自然に整形して JSON で返してください。
**金額は推定せず、入力に金額が無ければ unit_price は null を返してください。**
JSON のみを返し、前置きや説明文は一切含めないこと。`;

async function aiComplete(deal) {
  let runPrompt;
  try {
    const claude = require('./claude');
    runPrompt = claude.runPrompt;
  } catch (err) {
    process.stderr.write(`[warn] claude.js 読み込み失敗: ${err.message}\n`);
    return null;
  }

  const user = JSON.stringify({
    project_name:    deal.project_name,
    client_name:     deal.client_name,
    existing_billing: deal.billing || {},
  }, null, 2);

  const schema = `{
  "items": [
    { "name": "整形された品目名", "qty": 1, "unit_price": <number or null>, "tax_rate": 10 }
  ],
  "payment_terms": "月末締め翌月末払い",
  "notes": "請求書記載の口座へお振込みください。"
}`;

  let parsed = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text    = await runPrompt({
        system: AI_SYSTEM + '\n\n出力形式:\n' + schema,
        user,
        maxTokens: 512,
      });
      const cleaned = text.replace(/^```(?:json)?\s*\r?\n?/m, '').replace(/\r?\n?```\s*$/m, '').trim();
      parsed = JSON.parse(cleaned);
      if (!parsed.items) throw new Error('items フィールドが欠落');
      break;
    } catch (err) {
      process.stderr.write(`[warn] AI 補完 attempt ${attempt} 失敗: ${err.message}\n`);
    }
  }
  return parsed;
}

// ------------------------------------------------------------------ main API

/**
 * 受注案件から請求書下書き Markdown を生成する。
 * @param {object} deal - collectWonDeals() の 1 要素
 * @param {{ noAi?: boolean }} options
 * @returns {Promise<{
 *   markdown: string,
 *   metadata: {
 *     has_amount: boolean,
 *     needs_review: boolean,
 *     billing_source: 'frontmatter'|'ai-completed'|'needs-review',
 *     warnings: string[]
 *   }
 * }>}
 */
async function generateDraft(deal, options = {}) {
  const today          = todayJST();
  const billing        = deal.billing || {};
  const warnings       = [];
  let   billing_source = 'needs-review';
  let   items          = null;
  let   payment_terms  = billing.payment_terms || null;
  let   notes          = billing.notes         || null;

  // ── ケース 1: billing.items が揃っている ──────────────────────────────
  if (billing.items && billing.items.length > 0 && billing.amount != null) {
    items          = billing.items.map(item => ({
      name:        String(item.name || deal.project_name),
      qty:         Number.isInteger(item.qty) ? item.qty : 1,
      unit_price:  Number.isInteger(item.unit_price) ? item.unit_price : (billing.amount || null),
      tax_rate:    [8, 10].includes(item.tax_rate) ? item.tax_rate : (billing.tax_rate || 10),
    }));
    billing_source = 'frontmatter';

  // ── ケース 2: amount のみ (items 無し) ───────────────────────────────
  } else if (billing.amount != null && !billing.items) {
    items = [{
      name:       String(deal.project_name),
      qty:        1,
      unit_price: billing.amount,
      tax_rate:   billing.tax_rate || 10,
    }];
    billing_source = 'frontmatter';
    warnings.push('items が未指定のため amount から 1 行を自動生成しました。確認してください。');

  // ── ケース 3: billing が空 → AI 補完 ─────────────────────────────────
  } else {
    if (!options.noAi) {
      process.stderr.write('[info] AI で品目名・支払条件を補完中...\n');
      const aiResult = await aiComplete(deal);
      if (aiResult) {
        items         = (aiResult.items || []).map(item => ({
          name:       String(item.name || deal.project_name),
          qty:        Number.isInteger(item.qty) ? item.qty : 1,
          unit_price: Number.isInteger(item.unit_price) ? item.unit_price : null,
          tax_rate:   [8, 10].includes(item.tax_rate) ? item.tax_rate : 10,
        }));
        payment_terms = aiResult.payment_terms || payment_terms;
        notes         = aiResult.notes         || notes;
        billing_source = 'ai-completed';
      } else {
        billing_source = 'needs-review';
        warnings.push('AI 補完に失敗しました。品目名・支払条件を手動で入力してください。');
      }
    } else {
      billing_source = 'needs-review';
    }

    // amount が取れなかった場合の仮 items
    if (!items || items.length === 0) {
      items = [{
        name:       String(deal.project_name),
        qty:        1,
        unit_price: null,
        tax_rate:   billing.tax_rate || 10,
      }];
    }
    warnings.push('金額が未設定です。unit_price を入力してから npm run invoice を実行してください。');
  }

  // ── frontmatter 構築 ─────────────────────────────────────────────────
  const dueOffsetDays = billing.due_offset_days ?? 30;
  const dueDate       = addDays(today, dueOffsetDays);
  const has_amount    = items.every(i => i.unit_price != null);
  const needs_review  = !has_amount || billing_source === 'needs-review';

  const frontFields = {
    client_name:     deal.client_name    || null,
    client_address:  billing.client_address || null,
    client_honorific: billing.client_honorific || '御中',
    project_name:    deal.project_name   || null,
    issue_date:      today,
    due_date:        dueDate,
    payment_terms:   payment_terms        || null,
    withholding:     billing.withholding  || false,
    notes:           notes                || null,
  };

  const front = buildFrontmatter(frontFields, items);

  // ── 本文 ───────────────────────────────────────────────────────────
  const wonAt = deal.won_at instanceof Date
    ? deal.won_at.toISOString().slice(0, 10)
    : String(deal.won_at || today).slice(0, 10);

  const warnLines = warnings.map(w => `> ⚠️ ${w}`).join('\n');
  const body = `
> !! **営業 → 経理 自動生成された請求書下書き。**
> 最終確認後に \`npm run invoice -- <このファイルパス>\` を実行してください。
${needs_review ? '> **⚠️ needs_review=true: 金額や品目を必ず確認してください。**' : ''}
${warnLines ? warnLines : ''}

## 生成情報

| 項目 | 値 |
|---|---|
| 元案件 | ${deal.project_name} |
| 顧客 | ${deal.client_name} |
| 受注日 | ${wonAt} |
| データソース | ${deal.source} |
| 請求情報ソース | ${billing_source} |
| 生成日時 | ${toJSTISOString()} |
`.trim();

  return {
    markdown: `${front}\n\n${body}\n`,
    metadata: { has_amount, needs_review, billing_source, warnings },
  };
}

module.exports = { generateDraft };
