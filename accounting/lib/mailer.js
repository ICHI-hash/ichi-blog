'use strict';
// 全部門共通 Gmail モジュール (lib/mailer.js) への薄いラッパー。
// 実装ロジックは lib/mailer.js に移管しました。
// accounting スクリプトの require パスを変更しないためにこのファイルを残します。
module.exports = require('../../lib/mailer.js');
