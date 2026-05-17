'use strict';
/**
 * accounting/lib/sales-bridge.js
 * 営業パイプラインから「受注」案件を取得する。
 * morning-reminder.js (ESM) と同じデータソースを CJS で並列実装。
 * stage='受注' フィルタと billing フィールドの読み取りを追加。
 */
const fs   = require('fs');
const path = require('path');
const matter = require('gray-matter');

const { pathForInputs } = require('../../lib/paths.js');
const PIPELINE_DIR = pathForInputs('sales', 'pipeline');

// ------------------------------------------------------------------ Sheets

/**
 * Google Sheets から受注案件を取得する。
 * 失敗時は null を返してフォールバックを促す。
 * 列構造 (A〜M): project_name, client_name, stage, next_action,
 *   next_action_due, owner_note,
 *   billing_amount, billing_tax_rate, billing_payment_terms,
 *   billing_due_offset_days, billing_items_json,
 *   billing_client_address, billing_withholding
 */
async function collectFromSheets() {
  const sheetId = process.env.SALES_SHEET_ID;
  if (!sheetId) return null;

  try {
    const { getOAuthClient } = require('../../lib/mailer.js');
    const pkg    = require('googleapis');
    const google = pkg.google ?? pkg;
    const auth   = getOAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'A2:M',
    });

    const rows = (res.data.values || []).filter(r => r[0]);
    const wonRows = rows.filter(r => String(r[2] || '').trim() === '受注');

    return wonRows.map((r, idx) => {
      let billing = null;
      const rawAmt = r[6] ? parseInt(String(r[6]).replace(/[¥,\s]/g, ''), 10) : null;
      if (rawAmt || r[8]) {
        billing = {
          amount:           Number.isFinite(rawAmt) ? rawAmt : null,
          tax_rate:         r[7] ? parseInt(r[7], 10) : 10,
          payment_terms:    r[8]  || null,
          due_offset_days:  r[9]  ? parseInt(r[9], 10) : 30,
          items:            r[10] ? tryParseJson(r[10]) : null,
          client_address:   r[11] || null,
          withholding:      r[12] ? String(r[12]).toLowerCase() === 'true' : false,
        };
      }
      return {
        source:       'sheets',
        source_id:    `sheet-row-${idx + 2}`,
        project_name: String(r[0] || '').trim(),
        client_name:  String(r[1] || '').trim(),
        stage:        'received',
        won_at:       new Date(),
        billing,
        raw:          { row: r },
      };
    });
  } catch (err) {
    process.stderr.write(`[warn] Sheets 取得失敗 (${err.message})。ローカルにフォールバック。\n`);
    return null;
  }
}

function tryParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ------------------------------------------------------------------ local files

/**
 * sales/inputs/pipeline/*.md から受注 (stage='受注') 案件を読み込む。
 */
function collectFromLocalFiles() {
  const deals = [];
  let files = [];
  try {
    files = fs.readdirSync(PIPELINE_DIR)
      .filter(f => f.endsWith('.md') && f !== 'README.md');
  } catch {
    return [];
  }

  for (const file of files) {
    const filepath = path.resolve(PIPELINE_DIR, file);
    try {
      const { data: fm } = matter(fs.readFileSync(filepath, 'utf8'));
      if (String(fm.stage || '').trim() !== '受注') continue;
      if (!fm.project_name) continue;

      const mtime = fs.statSync(filepath).mtime;

      // billing フィールドの正規化
      let billing = null;
      if (fm.billing && typeof fm.billing === 'object') {
        const b = fm.billing;
        billing = {
          amount:          b.amount != null ? parseInt(String(b.amount), 10) || null : null,
          tax_rate:        b.tax_rate != null ? parseInt(String(b.tax_rate), 10) : 10,
          payment_terms:   b.payment_terms  || null,
          due_offset_days: b.due_offset_days ? parseInt(String(b.due_offset_days), 10) : 30,
          items:           Array.isArray(b.items) && b.items.length > 0 ? b.items : null,
          client_address:  b.client_address  || null,
          client_honorific: b.client_honorific || '御中',
          withholding:     Boolean(b.withholding),
          notes:           b.notes || null,
        };
      }

      deals.push({
        source:       'local',
        source_id:    filepath,
        project_name: String(fm.project_name || '').trim(),
        client_name:  String(fm.client_name  || '').trim(),
        stage:        '受注',
        won_at:       mtime,
        billing,
        raw:          fm,
      });
    } catch (err) {
      process.stderr.write(`[warn] ${file}: パース失敗 (${err.message})\n`);
    }
  }
  return deals;
}

// ------------------------------------------------------------------ public API

/**
 * ソースに応じて受注案件を取得する。
 * @param {{ source?: 'auto'|'sheets'|'local', since?: Date }} opts
 * @returns {Promise<object[]>}
 */
async function collectWonDeals({ source = 'auto', since } = {}) {
  let deals;

  if (source === 'sheets') {
    deals = await collectFromSheets();
    if (deals === null) {
      process.stderr.write('[warn] Sheets から取得できませんでした。\n');
      return [];
    }
  } else if (source === 'local') {
    deals = collectFromLocalFiles();
  } else {
    // auto: Sheets → local フォールバック
    const fromSheets = await collectFromSheets();
    deals = fromSheets !== null ? fromSheets : collectFromLocalFiles();
  }

  // since フィルタ
  if (since instanceof Date) {
    deals = deals.filter(d => d.won_at >= since);
  }

  return deals;
}

/**
 * 重複判定キーを生成する。
 * @param {object} deal
 * @returns {string}
 */
function makeDealKey(deal) {
  const sourceId = path.basename(String(deal.source_id || ''));
  const proj     = String(deal.project_name || '').replace(/\s+/g, '_').slice(0, 40);
  return `${deal.source}:${sourceId}:${proj}`;
}

module.exports = { collectWonDeals, makeDealKey };
