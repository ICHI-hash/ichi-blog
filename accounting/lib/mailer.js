'use strict';
// Gmail API (googleapis) を使って 1 通のメールを送信する薄いラッパー。
// 営業部門に共通メーラーが存在しなかったため accounting 独自に実装。
// 認証キー: GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN
//           GMAIL_USER (送信元アドレス)
//           BUSINESS_NOTIFY_EMAIL (既定送信先)

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const GMAIL_CLIENT_ID     = process.env.GMAIL_CLIENT_ID     || '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || '';
const GMAIL_USER          = process.env.GMAIL_USER          || '';
const DEFAULT_TO          = process.env.BUSINESS_NOTIFY_EMAIL || GMAIL_USER;

// RFC 2047 encoded-word でサブジェクトをエンコード
function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

// RFC 2822 形式のメッセージを base64url エンコードする
function buildRaw({ from, to, subject, body }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

/**
 * Gmail API でメールを送信する。
 * @param {{ to?: string, subject: string, body: string, dryRun?: boolean }} opts
 * @returns {{ sent: boolean, messageId?: string }}
 * @throws {Error} 認証情報が未設定、または API 呼び出し失敗
 */
async function sendMail({ to, subject, body, dryRun = false }) {
  const recipient = to || DEFAULT_TO;

  if (dryRun) {
    process.stdout.write('\n[DRY RUN] メール送信プレビュー\n');
    process.stdout.write(`  宛先: ${recipient}\n`);
    process.stdout.write(`  件名: ${subject}\n`);
    process.stdout.write('  本文:\n');
    process.stdout.write(body.split('\n').map(l => '    ' + l).join('\n') + '\n');
    return { sent: false, dryRun: true };
  }

  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error(
      'Gmail 認証情報が未設定です。' +
      '.env に GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN を設定するか、' +
      '--no-mail または --dry-run を指定してください。'
    );
  }

  if (!recipient) {
    throw new Error(
      '送信先が不明です。' +
      '.env に BUSINESS_NOTIFY_EMAIL または GMAIL_USER を設定するか、--to <アドレス> を指定してください。'
    );
  }

  const pkg    = require('googleapis');
  const google = pkg.google ?? pkg;
  const auth   = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });

  const gmail = google.gmail({ version: 'v1', auth });
  const raw   = buildRaw({ from: GMAIL_USER || 'me', to: recipient, subject, body });

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return { sent: true, messageId: result.data.id };
}

module.exports = { sendMail };
