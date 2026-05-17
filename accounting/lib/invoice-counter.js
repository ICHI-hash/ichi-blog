'use strict';
const fs = require('fs');
const { pathForState } = require('../../lib/paths.js');

const COUNTER_FILE = pathForState('accounting', 'invoice-counter.json');

function readCounter() {
  try {
    return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCounter(data) {
  // アトミック書き込み: tmp ファイルに書いて rename
  const tmp = COUNTER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, COUNTER_FILE);
}

/**
 * 次の請求書番号を発行する。
 * 年が変わると連番を 1 にリセットする。
 * 採番済みで後段が失敗した場合のロールバックは行わない(欠番は許容)。
 * @param {Date} [now=new Date()]
 * @returns {{ number: string, year: number, seq: number }}
 */
function issueNext(now = new Date()) {
  const year = now.getFullYear();
  // 書き込み直前に再読込してインクリメント
  const counter = readCounter();
  const seq = (counter && counter.year === year) ? counter.last + 1 : 1;
  writeCounter({ year, last: seq });
  return {
    number: `INV-${year}-${String(seq).padStart(4, '0')}`,
    year,
    seq,
  };
}

module.exports = { issueNext, readCounter };
