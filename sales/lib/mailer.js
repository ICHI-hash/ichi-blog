// 全部門共通 Gmail モジュール (lib/mailer.js) への薄い ESM ラッパー。
// lib/mailer.js は CJS のため createRequire 経由でインポートする。
// 詳細な API 仕様は lib/mailer.js の JSDoc を参照。
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const _require = createRequire(import.meta.url);
const _mailer  = _require(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../lib/mailer.js')
);

export const {
  sendMail,
  searchMessages,
  getMessage,
  downloadAttachment,
  getOAuthClient,
  isConfigured,
} = _mailer;
