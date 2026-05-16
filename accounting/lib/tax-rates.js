'use strict';
// 税率定数。法令改正時はこのファイルのみを更新する。

const STANDARD_TAX_RATE = 10;
const REDUCED_TAX_RATE  = 8;
// 10.21% / 20.42% を basis point の 100 倍(整数)で保持
const WITHHOLDING_RATE_LOW_BPS  = 1021;
const WITHHOLDING_RATE_HIGH_BPS = 2042;
const WITHHOLDING_THRESHOLD     = 1_000_000;
const WITHHOLDING_BASE_AMOUNT   = 102_100;
const LAST_UPDATED              = '2026-05';
const NOTE = '税率は 2026 年 5 月時点。法令改正時は本ファイルのみを更新。';

module.exports = {
  STANDARD_TAX_RATE,
  REDUCED_TAX_RATE,
  WITHHOLDING_RATE_LOW_BPS,
  WITHHOLDING_RATE_HIGH_BPS,
  WITHHOLDING_THRESHOLD,
  WITHHOLDING_BASE_AMOUNT,
  LAST_UPDATED,
  NOTE,
};
