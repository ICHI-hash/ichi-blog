'use strict';
// planning/lib/notion.js を薄くラップして再エクスポート。
// NOTION_TOKEN 未設定時は getClient() が null を返す(planning 側の実装に準拠)。
// 追加の accounting 固有ロジックは STEP 2 以降でここに追記する。
module.exports = require('../../planning/lib/notion.js');
