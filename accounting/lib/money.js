'use strict';
const { WITHHOLDING_THRESHOLD, WITHHOLDING_BASE_AMOUNT } = require('./tax-rates');

/**
 * 消費税額を計算する(円未満切り捨て)。
 * @param {number} amount - 税抜金額(円・整数)
 * @param {number} ratePercent - 税率(10 または 8)
 * @returns {number} 消費税額(整数)
 */
function calcConsumptionTax(amount, ratePercent) {
  return Math.floor(amount * ratePercent / 100);
}

/**
 * 源泉徴収税額を計算する(円未満切り捨て)。
 * 100万円以下: 10.21% / 100万円超: 超過分に 20.42% + 基礎額 102,100円
 * 整数演算で浮動小数点誤差を回避する。
 * @param {number} amount - 支払金額(税抜・円・整数)
 * @returns {number} 源泉徴収税額(整数)
 */
function calcWithholding(amount) {
  if (amount <= WITHHOLDING_THRESHOLD) {
    // 10.21% = 1021 / 10000
    return Math.floor(amount * 1021 / 10000);
  }
  // 超過分に 20.42% = 2042 / 10000
  return Math.floor((amount - WITHHOLDING_THRESHOLD) * 2042 / 10000) + WITHHOLDING_BASE_AMOUNT;
}

/**
 * オブジェクト配列の指定キーを合計する(整数)。
 * @param {Array<object>} items
 * @param {string} [key='amount']
 * @returns {number}
 */
function sumAmounts(items, key = 'amount') {
  return items.reduce((acc, item) => acc + (Number(item[key]) || 0), 0);
}

/**
 * 金額を日本円表記にフォーマットする。
 * @param {number} amount
 * @returns {string} 例: "¥1,234,567"
 */
function formatJPY(amount) {
  return '¥' + amount.toLocaleString('ja-JP');
}

/**
 * 明細合計が総額と一致することを検証する。
 * 不一致の場合は Error を throw する。
 * 請求書生成・月次レポートの最終出力前に必ず呼ぶ。
 * @param {Array<object>} parts - 明細の配列(各要素に amount プロパティ)
 * @param {number} total - 期待される合計値
 */
function assertReconcile(parts, total) {
  const sum = sumAmounts(parts);
  if (sum !== total) {
    throw new Error(
      `assertReconcile: 合計不一致 期待値=${total} 実際=${sum} 差分=${sum - total}`
    );
  }
}

module.exports = { calcConsumptionTax, calcWithholding, sumAmounts, formatJPY, assertReconcile };
