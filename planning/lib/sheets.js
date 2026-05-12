'use strict';

// B 案(新規実装): sales/pipeline は Google Apps Script のため REST API クライアントが存在しない。
// 同一シート構造(列: 顧客名/案件名/ステータス/次回アクション/次回アクション期日)を
// googleapis v4 クライアントで読み取る薄いラッパー。
//
// 必要な環境変数:
//   PIPELINE_SHEET_ID            … Google Sheets スプレッドシート ID
//   GOOGLE_SERVICE_ACCOUNT_JSON  … サービスアカウント JSON の内容(文字列)
//   GOOGLE_APPLICATION_CREDENTIALS … サービスアカウント JSON のファイルパス(上記の代替)
//   PIPELINE_SHEET_NAME          … シートタブ名(省略時: "pipeline")

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

function isEnabled() {
  return (
    Boolean(process.env.PIPELINE_SHEET_ID) &&
    (Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) ||
     Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS))
  );
}

/**
 * getPipelineRows() → Array<Row>
 *
 * シートのヘッダ行をキーにしたオブジェクト配列を返す。
 * 認証失敗・シート取得失敗時は throw する(呼び出し側でハンドリング)。
 */
async function getPipelineRows() {
  const { google } = require('googleapis');

  const spreadsheetId = process.env.PIPELINE_SHEET_ID;
  if (!spreadsheetId) throw new Error('PIPELINE_SHEET_ID が設定されていません。');

  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON のパースに失敗しました。有効な JSON 文字列を設定してください。');
    }
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else {
    // GOOGLE_APPLICATION_CREDENTIALS ファイルパス経由
    auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }

  const sheets = google.sheets({ version: 'v4', auth });
  const sheetName = process.env.PIPELINE_SHEET_NAME ?? 'pipeline';

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
  });

  const rows = data.values ?? [];
  if (rows.length === 0) return [];

  const [headers, ...dataRows] = rows;
  return dataRows
    .filter(row => row.some(cell => String(cell ?? '').trim()))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
      return obj;
    });
}

/**
 * findRowByProjectCode(rows, sheetsId) → Row | null
 *
 * `sheets_id`(案件名)で該当行を検索する。
 * sales/pipeline の列: 顧客名/案件名/ステータス/次回アクション/次回アクション期日
 * 「案件名」列または「案件コード」列に対して完全一致で照合する。
 */
function findRowByProjectCode(rows, sheetsId) {
  if (!sheetsId || !rows || rows.length === 0) return null;
  const needle = sheetsId.trim();
  return rows.find(row =>
    (row['案件名']   && row['案件名'].trim()   === needle) ||
    (row['案件コード'] && row['案件コード'].trim() === needle)
  ) ?? null;
}

module.exports = { isEnabled, getPipelineRows, findRowByProjectCode };
