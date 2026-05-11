// ====================================================
// ICHI 営業パイプライン リマインダー
// Google Apps Script (V8 runtime)
// ====================================================

const SHEET_NAME = 'pipeline';
const CLOSED_STATUSES = ['受注', '失注'];
const REQUIRED_COLS = ['顧客名', '案件名', 'ステータス', '次回アクション', '次回アクション期日'];

// メールテーブル用インライン CSS
const TH = 'padding:8px 12px;border:1px solid #d1d5db;text-align:left;' +
           'font-weight:600;color:#1e3a5f;white-space:nowrap;background:#f0f4ff';
const TD = 'padding:8px 12px;border:1px solid #e5e7eb;vertical-align:top';

// ----------------------------------------------------
// onOpen: カスタムメニューをスプレッドシートに追加
// ----------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ICHI 営業')
    .addItem('今すぐリマインダー実行', 'dailyCheck')
    .addItem('トリガー設定', 'setupTrigger')
    .addToUi();
}

// ----------------------------------------------------
// setupTrigger: 既存トリガーを全削除し毎日 9:00 JST に再設定
// ----------------------------------------------------
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyCheck')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('dailyCheck')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .inTimezone('Asia/Tokyo')
    .create();

  console.log('トリガー設定完了: dailyCheck を毎日 9:00 JST に実行');
  SpreadsheetApp.getUi().alert(
    'トリガーを設定しました。\n毎日 9:00（JST）に dailyCheck が自動実行されます。'
  );
}

// ----------------------------------------------------
// dailyCheck: 毎日 9:00 に実行されるエントリーポイント
// ----------------------------------------------------
function dailyCheck() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) {
    console.log(`シート "${SHEET_NAME}" が見つかりません`);
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    console.log('データがありません（ヘッダーのみ）');
    return;
  }

  // ヘッダー → 列インデックスのマッピング（列順変更に強い）
  const colMap = {};
  data[0].forEach((h, i) => { colMap[String(h).trim()] = i; });

  const missing = REQUIRED_COLS.filter(c => colMap[c] === undefined);
  if (missing.length > 0) {
    console.log(`必須列が見つかりません: ${missing.join(', ')}`);
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 次回アクション期日 <= 明日 23:59:59 を対象にする
  const threshold = new Date(today);
  threshold.setDate(threshold.getDate() + 1);
  threshold.setHours(23, 59, 59, 999);

  const actionRows = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    // 顧客名が空なら空行とみなしスキップ
    if (!row[colMap['顧客名']]) continue;

    const status = String(row[colMap['ステータス']] || '').trim();

    // クローズ済みはスキップ
    if (CLOSED_STATUSES.includes(status)) continue;

    const deadline = row[colMap['次回アクション期日']];

    // 次回アクション期日が Date 型でなければスキップ
    if (!(deadline instanceof Date) || isNaN(deadline.getTime())) continue;

    const deadlineDay = new Date(deadline);
    deadlineDay.setHours(0, 0, 0, 0);

    // 次回アクション期日が明日より後ならスキップ
    if (deadlineDay > threshold) continue;

    // 経過日数（正: 期日超過、0: 本日、負: 残り日数）
    const diffDays = Math.round((today - deadlineDay) / 86400000);
    const dueBadge =
      diffDays > 0 ? `${diffDays}日経過` :
      diffDays === 0 ? '本日' :
      `あと${Math.abs(diffDays)}日`;

    actionRows.push({
      customer:   String(row[colMap['顧客名']]     || ''),
      deal:       String(row[colMap['案件名']]     || ''),
      status:     status,
      nextAction: String(row[colMap['次回アクション']] || ''),
      deadline:   Utilities.formatDate(deadlineDay, 'Asia/Tokyo', 'yyyy/MM/dd'),
      dueBadge:   dueBadge,
      diffDays:   diffDays,
    });
  }

  if (actionRows.length === 0) {
    console.log('要対応案件はありません。メール送信をスキップします。');
    return;
  }

  // 期日超過が大きい順にソート
  actionRows.sort((a, b) => b.diffDays - a.diffDays);

  const subject = `[ICHI 営業] 本日の要対応 ${actionRows.length}件`;
  const htmlBody = buildHtmlEmail(actionRows, today);

  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail(),
    subject: subject,
    htmlBody: htmlBody,
  });

  console.log(`メール送信完了: ${subject}`);
}

// ----------------------------------------------------
// buildHtmlEmail: HTML メール本文を組み立てる
// ----------------------------------------------------
function buildHtmlEmail(rows, today) {
  const dateStr = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy年M月d日');

  const rowsHtml = rows.map(r => {
    const badgeColor =
      r.diffDays > 0 ? '#dc2626' :   // 超過 → 赤
      r.diffDays === 0 ? '#d97706' :  // 本日 → 橙
      '#2563eb';                       // 残り → 青

    return `<tr>
        <td style="${TD}">${escHtml(r.customer)}</td>
        <td style="${TD}">${escHtml(r.deal)}</td>
        <td style="${TD}">
          <span style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-size:12px">
            ${escHtml(r.status)}
          </span>
        </td>
        <td style="${TD}">${escHtml(r.nextAction)}</td>
        <td style="${TD};white-space:nowrap">${r.deadline}</td>
        <td style="${TD};text-align:center">
          <span style="color:${badgeColor};font-weight:700;font-size:13px">${r.dueBadge}</span>
        </td>
      </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,'Hiragino Sans',sans-serif;font-size:14px;color:#1a1a1a;margin:0;padding:0;background:#f9fafb">
  <div style="max-width:820px;margin:24px auto;background:#fff;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.12);overflow:hidden">

    <div style="background:#1e3a5f;padding:20px 28px">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:700">ICHI 営業 — 要対応リマインダー</h1>
      <p style="margin:4px 0 0;color:#93c5fd;font-size:13px">${dateStr} 時点　計 ${rows.length} 件</p>
    </div>

    <div style="padding:20px 28px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr>
            <th style="${TH}">顧客名</th>
            <th style="${TH}">案件名</th>
            <th style="${TH}">ステータス</th>
            <th style="${TH}">次回アクション</th>
            <th style="${TH}">次回アクション期日</th>
            <th style="${TH};text-align:center">状況</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

    <div style="background:#f9fafb;padding:12px 28px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280;text-align:right">
      ICHI 営業パイプライン（Google Apps Script）による自動送信
    </div>

  </div>
</body>
</html>`;
}

// ----------------------------------------------------
// escHtml: HTML インジェクション防止
// ----------------------------------------------------
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
