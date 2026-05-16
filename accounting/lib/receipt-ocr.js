'use strict';

const SYSTEM_PROMPT = `あなたは日本の領収書 OCR 専門 AI です。
画像/PDF から以下を JSON で抽出してください。
不明瞭な項目は null、信頼度を下げてください。
JSON のみを返し、前置きや説明文は一切含めないこと。

{
  "vendor": "取引先名(店舗名・会社名)",
  "amount": 税込合計金額(円・整数),
  "date": "取引日(YYYY-MM-DD形式)",
  "tax_amount": 消費税額(円・整数、記載なしならnull),
  "registration_number": "適格請求書発行事業者登録番号(T+13桁、なければnull)",
  "confidence": 0.0〜1.0の読み取り精度,
  "raw_text": "領収書の主要テキスト(200文字以内)"
}`;

/** JSON文字列からコードブロックを除去してパース */
function parseJsonResponse(text) {
  const cleaned = text
    .replace(/^```(?:json)?\s*\r?\n?/m, '')
    .replace(/\r?\n?```\s*$/m, '')
    .trim();
  const parsed = JSON.parse(cleaned);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('object が期待されます');
  return parsed;
}

/**
 * 領収書 (PDF または画像) を Claude vision で OCR し、構造化データを返す。
 * @param {Buffer} fileBuffer
 * @param {string} mimeType - 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp'
 * @returns {Promise<{
 *   vendor: string|null,
 *   amount: number|null,
 *   date: string|null,
 *   tax_amount: number|null,
 *   registration_number: string|null,
 *   confidence: number,
 *   needs_review: boolean,
 *   raw_text: string
 * }>}
 */
async function ocrReceipt(fileBuffer, mimeType) {
  // lazy-require して ANTHROPIC_API_KEY 未設定時のモジュールロードエラーを回避
  let getClient, MODEL;
  try {
    const claude = require('./claude');
    getClient = claude.getClient;
    MODEL     = claude.MODEL;
  } catch (err) {
    process.stderr.write(`[warn] claude.js 読み込み失敗: ${err.message}\n`);
    return { vendor: null, amount: null, date: null, tax_amount: null,
             registration_number: null, confidence: 0, needs_review: true, raw_text: '' };
  }

  const isPdf   = mimeType === 'application/pdf';
  const isImage = mimeType.startsWith('image/');

  if (!isPdf && !isImage) {
    process.stderr.write(`[warn] 非対応 mimeType: ${mimeType}\n`);
    return { vendor: null, amount: null, date: null, tax_amount: null,
             registration_number: null, confidence: 0, needs_review: true, raw_text: '' };
  }

  const base64Data = fileBuffer.toString('base64');
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
    : { type: 'image',    source: { type: 'base64', media_type: mimeType,           data: base64Data } };

  const messages = [{
    role: 'user',
    content: [
      contentBlock,
      { type: 'text', text: '上記の領収書から情報を抽出し、指定の JSON フォーマットで返してください。' },
    ],
  }];

  const client = getClient();
  let parsed = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await client.messages.create({
        model:      MODEL,
        max_tokens: 1024,
        system:     SYSTEM_PROMPT,
        messages,
      });
      const text = res.content[0]?.text || '';
      parsed = parseJsonResponse(text);
      break;
    } catch (err) {
      lastError = err;
      process.stderr.write(`[warn] OCR attempt ${attempt} 失敗: ${err.message}\n`);
    }
  }

  if (!parsed) {
    process.stderr.write(`[warn] OCR JSON パース 3 回失敗。needs_review=true で返します。\n`);
    return { vendor: null, amount: null, date: null, tax_amount: null,
             registration_number: null, confidence: 0, needs_review: true, raw_text: '' };
  }

  // 数値整数化
  const amount     = Number.isInteger(parsed.amount)     ? parsed.amount
                   : (parsed.amount != null ? Math.floor(Number(parsed.amount)) : null);
  const tax_amount = Number.isInteger(parsed.tax_amount) ? parsed.tax_amount
                   : (parsed.tax_amount != null ? Math.floor(Number(parsed.tax_amount)) : null);
  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence)) : 0;

  const needs_review = confidence < 0.7 || amount == null || amount <= 0;

  return {
    vendor:              parsed.vendor              ?? null,
    amount:              amount,
    date:                parsed.date                ?? null,
    tax_amount:          tax_amount,
    registration_number: parsed.registration_number ?? null,
    confidence,
    needs_review,
    raw_text:            String(parsed.raw_text || '').slice(0, 200),
  };
}

module.exports = { ocrReceipt };
