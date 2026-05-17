'use strict';
const fs   = require('fs');
const path = require('path');

const { pathForState } = require('../../lib/paths.js');
const SENT_FILE = pathForState('accounting', 'payments-sent.json');

function atomicWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filepath);
}

function toJSTISOString() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

/**
 * payable_id を生成する。
 * vendor_name と invoice_number から決定論的に生成するため、
 * ファイル名に依存しない。
 */
function makePayableId(vendorName, invoiceNumber) {
  return `${vendorName}__${invoiceNumber}`;
}

/**
 * payments-sent.json を読む。存在しない場合は { sent: {} } を返す。
 * @returns {{ sent: object }}
 */
function loadSent() {
  try {
    return JSON.parse(fs.readFileSync(SENT_FILE, 'utf8'));
  } catch {
    return { sent: {} };
  }
}

/** payments-sent.json に保存する(アトミック書き込み)。 */
function saveSent(data) {
  fs.mkdirSync(path.dirname(SENT_FILE), { recursive: true });
  atomicWrite(SENT_FILE, data);
}

/**
 * 同一 (payableId, reminderType, today) の送信記録があるか確認する。
 * @param {string} payableId - makePayableId() の戻り値
 * @param {string} reminderType - "3days" | "7days" | "today" | "overdue"
 * @param {string} today - "YYYY-MM-DD"
 * @returns {boolean}
 */
function isSent(payableId, reminderType, today) {
  const key = `${payableId}__${reminderType}__${today}`;
  return Object.prototype.hasOwnProperty.call(loadSent().sent, key);
}

/**
 * 送信記録を追記する。
 * @param {{ vendor_name, invoice_number, due_date, amount, reminder_type, today }} entry
 */
function recordSent(entry) {
  const { vendor_name, invoice_number, due_date, amount, reminder_type, today } = entry;
  const data  = loadSent();
  const payId = makePayableId(vendor_name, invoice_number);
  const key   = `${payId}__${reminder_type}__${today}`;
  data.sent[key] = {
    vendor_name,
    invoice_number,
    due_date,
    amount,
    reminder_type,
    sent_at: toJSTISOString(),
  };
  saveSent(data);
}

module.exports = { makePayableId, loadSent, saveSent, isSent, recordSent };
