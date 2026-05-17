'use strict';
const fs   = require('fs');
const path = require('path');

const { pathForState } = require('../../lib/paths.js');
const STATE_FILE = pathForState('accounting', 'sales-to-accounting.json');

function atomicWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filepath);
}

function toJSTISOString() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00');
}

/** state/sales-to-accounting.json を読む。存在しない場合は { generated: {} } を返す。 */
function loadGenerated() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { generated: {} };
  }
}

/** state/sales-to-accounting.json を保存する(アトミック書き込み)。 */
function saveGenerated(data) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  atomicWrite(STATE_FILE, data);
}

/**
 * 指定の dealKey が既に処理済みか確認する。
 * @param {string} dealKey
 * @returns {boolean}
 */
function isGenerated(dealKey) {
  return Object.prototype.hasOwnProperty.call(loadGenerated().generated, dealKey);
}

/**
 * 生成記録を追記する。
 * @param {{
 *   deal_key: string,
 *   project_name: string,
 *   client_name: string,
 *   draft_path: string,
 *   needs_review: boolean,
 *   amount: number|null,
 *   billing_source: 'frontmatter'|'ai-completed'|'needs-review'
 * }} entry
 */
function recordGenerated(entry) {
  const data = loadGenerated();
  data.generated[entry.deal_key] = {
    deal_key:              entry.deal_key,
    project_name:          entry.project_name        || '',
    client_name:           entry.client_name         || '',
    generated_at:          toJSTISOString(),
    draft_path:            entry.draft_path           || '',
    needs_review:          Boolean(entry.needs_review),
    amount:                entry.amount               ?? null,
    billing_source:        entry.billing_source       || 'needs-review',
    reviewed_at:           null,
    issued_invoice_number: null,
  };
  saveGenerated(data);
}

/**
 * 請求書発行後に issued_invoice_number と reviewed_at を更新する。
 * draft_path で一致するエントリを探す。
 * @param {string} draftPath - 下書きファイルのパス(相対・絶対どちらも可)
 * @param {string} invoiceNumber - 採番された請求書番号
 */
function updateIssued(draftPath, invoiceNumber) {
  const data = loadGenerated();
  const relPath = draftPath.replace(/\\/g, '/');
  let updated = false;

  for (const [key, entry] of Object.entries(data.generated)) {
    const entryPath = (entry.draft_path || '').replace(/\\/g, '/');
    if (relPath.endsWith(entryPath) || entryPath.endsWith(relPath) ||
        path.basename(relPath) === path.basename(entryPath)) {
      entry.issued_invoice_number = invoiceNumber;
      entry.reviewed_at           = toJSTISOString();
      updated = true;
      break;
    }
  }

  if (updated) saveGenerated(data);
  return updated;
}

module.exports = { loadGenerated, saveGenerated, isGenerated, recordGenerated, updateIssued };
