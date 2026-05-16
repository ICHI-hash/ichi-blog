'use strict';
/**
 * lib/mailer.js — 全部門共通 Gmail ユーティリティ (CJS)
 *
 * 必要な .env キー:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   GMAIL_USER          (送信元アドレス)
 *   BUSINESS_NOTIFY_EMAIL (既定送信先)
 *
 * 各部門からの利用:
 *   accounting/lib/mailer.js → require('../../lib/mailer.js')
 *   sales/lib/mailer.js      → createRequire 経由で同ファイルを ESM ラップ
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// ------------------------------------------------------------------ auth helpers

/**
 * Gmail OAuth2 クライアントを構築して返す。
 * 認証情報が未設定なら throw する。
 * @returns {import('googleapis').Auth.OAuth2Client}
 */
function getOAuthClient() {
  const id     = process.env.GMAIL_CLIENT_ID     || '';
  const secret = process.env.GMAIL_CLIENT_SECRET || '';
  const token  = process.env.GMAIL_REFRESH_TOKEN || '';
  if (!id || !secret || !token) {
    throw new Error(
      'Gmail 認証情報が未設定です。' +
      '.env に GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN を設定するか、' +
      '--no-mail または --dry-run を指定してください。'
    );
  }
  const pkg    = require('googleapis');
  const google = pkg.google ?? pkg;
  const auth   = new google.auth.OAuth2(id, secret);
  auth.setCredentials({ refresh_token: token });
  return auth;
}

/**
 * Gmail 認証情報が揃っているか判定する。
 * @returns {boolean}
 */
function isConfigured() {
  return Boolean(
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN
  );
}

// ------------------------------------------------------------------ MIME builders

function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/**
 * RFC 2822 メッセージを構築し base64url エンコードして返す。
 * attachments がある場合は multipart/mixed で構築する。
 */
function buildRaw({ from, to, subject, body, attachments = [] }) {
  const header = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
  ];

  if (attachments.length === 0) {
    header.push('Content-Type: text/plain; charset=UTF-8');
    header.push('Content-Transfer-Encoding: base64');
    header.push('');
    header.push(Buffer.from(body, 'utf8').toString('base64'));
    return Buffer.from(header.join('\r\n'), 'utf8').toString('base64url');
  }

  const boundary = `ichi_mailer_${Date.now()}`;
  header.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  header.push('');

  const parts = [];

  // テキスト本文パート
  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/plain; charset=UTF-8');
  parts.push('Content-Transfer-Encoding: base64');
  parts.push('');
  parts.push(Buffer.from(body, 'utf8').toString('base64'));

  // 添付ファイルパート
  for (const att of attachments) {
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${att.mimeType || 'application/octet-stream'}`);
    parts.push('Content-Transfer-Encoding: base64');
    parts.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    parts.push('');
    parts.push(att.content.toString('base64'));
  }
  parts.push(`--${boundary}--`);

  const raw = header.join('\r\n') + '\r\n' + parts.join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64url');
}

// ------------------------------------------------------------------ send

/**
 * Gmail API でメールを 1 通送信する。
 * @param {{
 *   to?: string,
 *   subject: string,
 *   body: string,
 *   attachments?: Array<{ filename: string, content: Buffer, mimeType: string }>,
 *   dryRun?: boolean
 * }} opts
 * @returns {Promise<{ sent: boolean, messageId?: string }>}
 * @throws {Error} 認証情報未設定 / API エラー
 */
async function sendMail({ to, subject, body, attachments = [], dryRun = false }) {
  const defaultTo = process.env.BUSINESS_NOTIFY_EMAIL || process.env.GMAIL_USER || '';
  const recipient = to || defaultTo;

  if (dryRun) {
    process.stdout.write('\n[DRY RUN] メール送信プレビュー\n');
    process.stdout.write(`  宛先: ${recipient || '(未設定)'}\n`);
    process.stdout.write(`  件名: ${subject}\n`);
    if (attachments.length > 0) {
      process.stdout.write(`  添付: ${attachments.map(a => a.filename).join(', ')}\n`);
    }
    process.stdout.write('  本文:\n');
    process.stdout.write(body.split('\n').map(l => '    ' + l).join('\n') + '\n');
    return { sent: false, dryRun: true };
  }

  const auth = getOAuthClient(); // throws if unconfigured

  if (!recipient) {
    throw new Error(
      '送信先が不明です。.env に BUSINESS_NOTIFY_EMAIL または GMAIL_USER を設定するか、' +
      '--to <アドレス> を指定してください。'
    );
  }

  const pkg    = require('googleapis');
  const google = pkg.google ?? pkg;
  const gmail  = google.gmail({ version: 'v1', auth });
  const from   = process.env.GMAIL_USER || 'me';
  const raw    = buildRaw({ from, to: recipient, subject, body, attachments });

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return { sent: true, messageId: result.data.id };
}

// ------------------------------------------------------------------ receive (stubs)

/**
 * Gmail メッセージを検索する。
 * @param {{ query?: string, maxResults?: number, after?: string, before?: string }} opts
 *   - query: Gmail API の q パラメータ (例: 'from:amazon subject:領収書')
 *   - maxResults: 最大取得件数 (デフォルト 20)
 *   - after: YYYY-MM-DD 以降のメッセージ
 *   - before: YYYY-MM-DD 以前のメッセージ
 * @returns {Promise<Array<{ id: string, threadId: string, snippet: string, from: string, subject: string, date: string }>>}
 * @throws {Error} Not implemented yet
 */
async function searchMessages({ query, maxResults, after, before } = {}) {
  throw new Error('Not implemented yet. To be implemented in receipt-ocr task.');
}

/**
 * 単一メッセージの全内容(本文 + 添付メタ)を取得する。
 * @param {string} messageId - Gmail メッセージ ID
 * @returns {Promise<object>} メッセージフルオブジェクト
 * @throws {Error} Not implemented yet
 */
async function getMessage(messageId) {
  throw new Error('Not implemented yet. To be implemented in receipt-ocr task.');
}

/**
 * 指定メッセージの添付ファイルをダウンロードして Buffer で返す。
 * @param {string} messageId - Gmail メッセージ ID
 * @param {string} attachmentId - 添付ファイル ID
 * @returns {Promise<Buffer>}
 * @throws {Error} Not implemented yet
 */
async function downloadAttachment(messageId, attachmentId) {
  throw new Error('Not implemented yet. To be implemented in receipt-ocr task.');
}

// ------------------------------------------------------------------ exports

module.exports = {
  sendMail,
  searchMessages,
  getMessage,
  downloadAttachment,
  getOAuthClient,
  isConfigured,
};
