'use strict';
/**
 * !! 重要 !!
 * このモジュールは概算計算のみを行う補助ツールです。
 * 各種所得控除(基礎控除・青色申告特別控除・社会保険料控除・
 * 配偶者控除・扶養控除など)、税額控除、損益通算、繰越欠損金等は
 * 一切考慮していません。
 * 確定申告と納税額確定は必ず税理士に依頼してください。
 * 税率は 2026 年 5 月時点。法令改正時は tax-rates.js と
 * tax-estimate.js を更新すること。
 */

// 所得税 超過累進テーブル (2026-05時点)
// { max: 上限(Infinity=無制限), rateBps: 税率×100, deduction: 控除額 }
const INCOME_TAX_BRACKETS = [
  { max: 1_950_000,  rateBps: 500,  deduction: 0 },
  { max: 3_300_000,  rateBps: 1000, deduction: 97_500 },
  { max: 6_950_000,  rateBps: 2000, deduction: 427_500 },
  { max: 9_000_000,  rateBps: 2300, deduction: 636_000 },
  { max: 18_000_000, rateBps: 3300, deduction: 1_536_000 },
  { max: 40_000_000, rateBps: 4000, deduction: 2_796_000 },
  { max: Infinity,   rateBps: 4500, deduction: 4_796_000 },
];

// 簡易課税みなし仕入率(事業区分 → %)
const DEEMED_PURCHASE_RATES = { '1': 90, '2': 80, '3': 70, '4': 60, '5': 50, '6': 40 };

// ------------------------------------------------------------------ income tax

/**
 * 所得税(復興特別所得税 2.1% 込み)を計算する。
 * taxableIncome は控除適用後の課税所得(整数・円)。
 * @param {number} taxableIncome
 * @returns {{ base_tax: number, special_reconstruction_tax: number, total: number }}
 */
function estimateIncomeTax(taxableIncome) {
  const income = Math.max(0, Math.floor(taxableIncome));
  const bracket = INCOME_TAX_BRACKETS.find(b => income <= b.max);
  // 整数算術: rateBps / 10000 = 税率
  const base_tax = Math.max(0, Math.floor(income * bracket.rateBps / 10000) - bracket.deduction);
  // 2.1% = 21/1000
  const special_reconstruction_tax = Math.floor(base_tax * 21 / 1000);
  return { base_tax, special_reconstruction_tax, total: base_tax + special_reconstruction_tax };
}

// ------------------------------------------------------------------ resident tax

/**
 * 住民税を概算で計算する(一律 10%)。
 * 均等割(年 5,000 円程度)は含まない。
 * @param {number} taxableIncome - 課税所得(円・整数)
 * @returns {{ total: number }}
 */
function estimateResidentTax(taxableIncome) {
  const income = Math.max(0, Math.floor(taxableIncome));
  return { total: Math.floor(income * 10 / 100) };
}

// ------------------------------------------------------------------ consumption tax

/**
 * 消費税(本則課税): 預かり税額 - 支払税額。
 * @param {number} taxableSalesTax - 課税売上に対する預かり消費税(円・整数)
 * @param {number} taxableExpensesTax - 課税仕入に対する支払消費税(円・整数)
 * @returns {number} 納税額(最小 0)
 */
function estimateConsumptionTaxGeneral(taxableSalesTax, taxableExpensesTax) {
  return Math.max(0, Math.floor(taxableSalesTax) - Math.floor(taxableExpensesTax));
}

/**
 * 消費税(簡易課税): みなし仕入率を適用。
 * @param {number} taxableSales - 税抜課税売上(円・整数)
 * @param {string} businessCategory - '1'〜'6' (デフォルト '5' = サービス業)
 * @returns {{ taxAmount: number, deductible: number, payable: number }}
 */
function estimateConsumptionTaxSimple(taxableSales, businessCategory = '5') {
  const rate     = DEEMED_PURCHASE_RATES[String(businessCategory)] ?? 50;
  const taxAmount   = Math.floor(Math.max(0, taxableSales) * 10 / 100);
  const deductible  = Math.floor(taxAmount * rate / 100);
  return { taxAmount, deductible, payable: taxAmount - deductible };
}

// ------------------------------------------------------------------ monthly estimate

/**
 * ある月の収支を年換算し、月割の推定納税額を返す。
 * @param {{
 *   monthlyTaxableIncome: number,
 *   monthlyTaxableSalesEx: number,
 *   monthlyTaxableSalesTax: number,
 *   monthlyTaxableExpensesTax: number,
 *   taxStatus: 'taxable'|'tax_exempt',
 *   taxMethod: 'general'|'simple',
 *   businessCategory: string,
 * }} params
 * @returns {{
 *   income_tax_monthly: number,
 *   resident_tax_monthly: number,
 *   consumption_tax_monthly: number,
 *   total_monthly: number,
 *   annualized_income: number,
 *   basis: string,
 * }}
 */
function estimateMonthlyTax({
  monthlyTaxableIncome,
  monthlyTaxableSalesEx,
  monthlyTaxableSalesTax,
  monthlyTaxableExpensesTax,
  taxStatus,
  taxMethod,
  businessCategory,
}) {
  const annualized = Math.floor(monthlyTaxableIncome) * 12;

  const it  = estimateIncomeTax(annualized);
  const rt  = estimateResidentTax(annualized);

  const income_tax_monthly   = Math.floor(it.total  / 12);
  const resident_tax_monthly = Math.floor(rt.total  / 12);

  let consumption_tax_monthly = 0;
  if (taxStatus !== 'tax_exempt') {
    if (taxMethod === 'general') {
      consumption_tax_monthly = estimateConsumptionTaxGeneral(
        monthlyTaxableSalesTax, monthlyTaxableExpensesTax
      );
    } else {
      const r = estimateConsumptionTaxSimple(monthlyTaxableSalesEx, businessCategory);
      consumption_tax_monthly = r.payable;
    }
  }

  return {
    income_tax_monthly,
    resident_tax_monthly,
    consumption_tax_monthly,
    total_monthly: income_tax_monthly + resident_tax_monthly + consumption_tax_monthly,
    annualized_income: annualized,
    basis: '月の値を年換算した粗い概算。控除・損益通算等は未考慮。',
  };
}

module.exports = {
  estimateIncomeTax,
  estimateResidentTax,
  estimateConsumptionTaxGeneral,
  estimateConsumptionTaxSimple,
  estimateMonthlyTax,
  // テーブル定数 (tax-rates-summary.js でチェックリスト生成に使用)
  INCOME_TAX_BRACKETS,
  DEEMED_PURCHASE_RATES,
};
