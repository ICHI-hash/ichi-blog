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

// ------------------------------------------------------------------ receive (gmail.readonly スコープが必要)
// !! OAuth スコープに https://www.googleapis.com/auth/gmail.readonly を追加すること !!

/**
 * base64url → Buffer (Gmail API の data フィールドを安全にデコードする)
 * @param {string} s
 * @returns {Buffer}
 */
function decodeBase64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Gmail MIME ツリーを再帰的に走査して本文と添付を収集する。
 * @param {object[]} parts
 * @param {{ text: string, html: string }} body
 * @param {object[]} attachments
 */
function walkMimeParts(parts, body, attachments) {
  for (const part of parts) {
    const ct          = (part.mimeType || '').toLowerCase();
    const disp        = (part.headers || [])
      .find(h => h.name.toLowerCase() === 'content-disposition')?.value || '';
    const hasFile     = Boolean(part.filename);
    const hasAttachId = Boolean(part.body?.attachmentId);

    if (part.parts) {
      walkMimeParts(part.parts, body, attachments);
    } else if (ct === 'text/plain' && !hasFile) {
      if (part.body?.data) body.text += decodeBase64url(part.body.data).toString('utf8');
    } else if (ct === 'text/html' && !hasFile) {
      if (part.body?.data) body.html += decodeBase64url(part.body.data).toString('utf8');
    } else if (hasAttachId && hasFile) {
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename:     part.filename,
        mimeType:     part.mimeType || 'application/octet-stream',
        size:         part.body.size || 0,
      });
    }
  }
}

/**
 * Gmail メッセージを検索して [{ id, threadId }] を返す。
 * @param {{
 *   query?: string,
 *   maxResults?: number,
 *   after?: Date,
 *   before?: Date
 * }} opts
 * @returns {Promise<Array<{ id: string, threadId: string }>>}
 */
async function searchMessages({ query = '', maxResults = 100, after, before } = {}) {
  const auth   = getOAuthClient();
  const pkg    = require('googleapis');
  const google = pkg.google ?? pkg;
  const gmail  = google.gmail({ version: 'v1', auth });

  let q = query;
  function fmtDate(d) {
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }
  if (after  instanceof Date) q += ` after:${fmtDate(after)}`;
  if (before instanceof Date) q += ` before:${fmtDate(before)}`;

  const res = await gmail.users.messages.list({
    userId:     'me',
    q:          q.trim(),
    maxResults: Math.min(Math.max(1, maxResults), 500),
  });

  return (res.data.messages || []).map(m => ({ id: m.id, threadId: m.threadId }));
}

/**
 * 単一メッセージの全内容(本文 + 添付メタ)を取得する。
 * @param {string} messageId
 * @returns {Promise<{
 *   id, threadId, internalDate,
 *   from, to, subject, snippet,
 *   date: Date,
 *   body: { text: string, html: string },
 *   attachments: Array<{ attachmentId, filename, mimeType, size }>
 * }>}
 */
async function getMessage(messageId) {
  const auth   = getOAuthClient();
  const pkg    = require('googleapis');
  const google = pkg.google ?? pkg;
  const gmail  = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const msg = res.data;

  // ヘッダを辞書化
  const hdr = {};
  for (const h of (msg.payload?.headers || [])) hdr[h.name.toLowerCase()] = h.value;

  const body        = { text: '', html: '' };
  const attachments = [];
  const payload     = msg.payload;

  if (payload?.parts) {
    walkMimeParts(payload.parts, body, attachments);
  } else if (payload?.body?.data) {
    const ct = (payload.mimeType || '').toLowerCase();
    const decoded = decodeBase64url(payload.body.data).toString('utf8');
    if (ct === 'text/plain') body.text = decoded;
    else if (ct === 'text/html') body.html = decoded;
  }

  return {
    id:           msg.id,
    threadId:     msg.threadId,
    internalDate: msg.internalDate,
    from:         hdr['from']    || '',
    to:           hdr['to']      || '',
    subject:      hdr['subject'] || '',
    snippet:      msg.snippet    || '',
    date:         new Date(parseInt(msg.internalDate, 10)),
    body,
    attachments,
  };
}

const LIMIT_WARN = 5  * 1024 * 1024; // 5 MB
const LIMIT_SKIP = 10 * 1024 * 1024; // 10 MB

/**
 * 指定メッセージの添付ファイルをダウンロードして Buffer で返す。
 * 10 MB 超は null を返す。5 MB 超は警告ログを出してダウンロードする。
 * @param {string} messageId
 * @param {string} attachmentId
 * @returns {Promise<Buffer|null>}
 */
async function downloadAttachment(messageId, attachmentId) {
  const auth   = getOAuthClient();
  const pkg    = require('googleapis');
  const google = pkg.google ?? pkg;
  const gmail  = google.gmail({ version: 'v1', auth });

  const res  = await gmail.users.messages.attachments.get({
    userId:    'me',
    messageId,
    id:        attachmentId,
  });

  const size = res.data.size || 0;
  if (size > LIMIT_SKIP) {
    process.stderr.write(`[warn] 添付が 10 MB を超えるためスキップ (size=${size})\n`);
    return null;
  }
  if (size > LIMIT_WARN) {
    process.stderr.write(`[warn] 添付が 5 MB を超えています (size=${size})。取得を続行します。\n`);
  }

  return decodeBase64url(res.data.data);
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
