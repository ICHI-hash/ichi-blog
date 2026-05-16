'use strict';
/**
 * accounting/lib/tax-rates-summary.js
 * tax-rates.js と tax-estimate.js の定数を構造化して返す。
 * tax-rates-check.js が Markdown / JSON チェックリスト生成に使用する。
 */
const {
  STANDARD_TAX_RATE,
  REDUCED_TAX_RATE,
  WITHHOLDING_RATE_LOW_BPS,
  WITHHOLDING_RATE_HIGH_BPS,
  WITHHOLDING_THRESHOLD,
  WITHHOLDING_BASE_AMOUNT,
  LAST_UPDATED,
} = require('./tax-rates');

const {
  INCOME_TAX_BRACKETS,
  DEEMED_PURCHASE_RATES,
} = require('./tax-estimate');

const BUSINESS_CATEGORY_NAMES = {
  '1': '卸売業',
  '2': '小売業',
  '3': '製造業等',
  '4': 'その他事業',
  '5': 'サービス業等',
  '6': '不動産業',
};

/**
 * 現在リポジトリに組み込まれている税率の構造化サマリを返す。
 * @returns {object}
 */
function buildSummary() {
  const income_brackets = INCOME_TAX_BRACKETS.map(b => ({
    limit:     b.max === Infinity ? null : b.max,
    rate:      `${b.rateBps / 100}%`,
    deduction: b.deduction,
  }));

  const consumption_simple_categories = Object.entries(DEEMED_PURCHASE_RATES).map(([code, rate]) => ({
    code,
    name: BUSINESS_CATEGORY_NAMES[code] || '不明',
    rate: `${rate}%`,
  }));

  return {
    last_updated: LAST_UPDATED,
    rates: {
      consumption_standard:        STANDARD_TAX_RATE,
      consumption_reduced:         REDUCED_TAX_RATE,
      withholding_low_rate_pct:    `${WITHHOLDING_RATE_LOW_BPS / 100}%`,
      withholding_high_rate_pct:   `${WITHHOLDING_RATE_HIGH_BPS / 100}%`,
      withholding_threshold:       WITHHOLDING_THRESHOLD,
      withholding_base_amount:     WITHHOLDING_BASE_AMOUNT,
      income_brackets,
      resident_tax_rate:           '10%',
      consumption_simple_categories,
    },
    references: [
      {
        title: '国税庁: No.2260 所得税の税率',
        url:   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm',
      },
      {
        title: '国税庁: 消費税の軽減税率制度の概要',
        url:   'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/01.htm',
      },
      {
        title: '国税庁: インボイス制度について',
        url:   'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm',
      },
      {
        title: '国税庁: 令和8年版 源泉徴収のあらまし',
        url:   'https://www.nta.go.jp/publication/pamph/gensen/aramashi2026/index.htm',
      },
      {
        title: '国税庁: No.2792 源泉徴収が必要な報酬・料金等とは',
        url:   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2792.htm',
      },
      {
        title: '国税庁: No.6509 簡易課税制度の事業区分',
        url:   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6509.htm',
      },
      {
        title: '国税庁: No.6505 簡易課税制度',
        url:   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm',
      },
      {
        title: '財務省: 税制改正の概要',
        url:   'https://www.mof.go.jp/tax_policy/tax_reform/outline/index.html',
      },
    ],
  };
}

module.exports = { buildSummary };
