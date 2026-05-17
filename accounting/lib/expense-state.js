'use strict';
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const { pathForState } = require('../../lib/paths.js');
const CATEGORIZED_FILE     = pathForState('accounting', 'categorized.json');
const VENDOR_REGISTRY_FILE = pathForState('accounting', 'vendor-registry.json');

// ------------------------------------------------------------------ helpers

function toJSTISOString() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

function atomicWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filepath);
}

// ------------------------------------------------------------------ hash

/**
 * date|description|amount の SHA-256 先頭 16 文字でハッシュを計算する。
 * description は前後空白除去・連続空白を 1 個に正規化してからハッシュ。
 * @param {{ date: string, description: string, amount: number }} tx
 * @returns {string}
 */
function computeHash(tx) {
  const desc = String(tx.description || '').trim().replace(/\s+/g, ' ');
  const key = `${tx.date}|${desc}|${tx.amount}`;
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------ categorized.json

/**
 * categorized.json を読み込んで Map<hash, entry> を返す。
 * ファイルが存在しない場合は空 Map を返す。
 */
function loadProcessed() {
  try {
    const raw = JSON.parse(fs.readFileSync(CATEGORIZED_FILE, 'utf8'));
    return new Map(Object.entries(raw.processed || {}));
  } catch {
    return new Map();
  }
}

/**
 * Map<hash, entry> を categorized.json に保存する(アトミック書き込み)。
 * @param {Map<string, object>} map
 */
function saveProcessed(map) {
  const processed = {};
  for (const [hash, entry] of map) {
    processed[hash] = entry;
  }
  atomicWrite(CATEGORIZED_FILE, { processed });
}

/**
 * 指定ハッシュが処理済みかどうかを確認する(単発チェック用)。
 * @param {string} hash
 * @returns {boolean}
 */
function isProcessed(hash) {
  return loadProcessed().has(hash);
}

/**
 * 単一エントリを categorized.json に追記する(単発追加用)。
 * entry に hash プロパティが必須。
 * @param {object} entry
 */
function recordProcessed(entry) {
  const map = loadProcessed();
  map.set(entry.hash, { ...entry, categorized_at: entry.categorized_at || toJSTISOString() });
  saveProcessed(map);
}

/**
 * 直近 n 件の仕訳例を [{description, account}] 配列で返す。
 * Claude プロンプトの few-shot 例として使用する。
 * @param {number} [n=100]
 * @returns {Array<{description: string, account: string}>}
 */
function recentSamples(n = 100) {
  const map = loadProcessed();
  return Array.from(map.values())
    .filter(e => e.description && e.account)
    .sort((a, b) => (a.categorized_at > b.categorized_at ? -1 : 1))
    .slice(0, n)
    .map(e => ({ description: e.description, account: e.account }));
}

// ------------------------------------------------------------------ vendor-registry.json

/**
 * vendor-registry.json を読み込む。存在しない場合は空オブジェクトを返す。
 * @returns {object}
 */
function loadVendorRegistry() {
  try {
    return JSON.parse(fs.readFileSync(VENDOR_REGISTRY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * vendor-registry.json を保存する(アトミック書き込み)。
 * @param {object} registry
 */
function saveVendorRegistry(registry) {
  atomicWrite(VENDOR_REGISTRY_FILE, registry);
}

/**
 * 取引先名(description)でレジストリを部分一致検索する。
 * 見つかった場合は { vendor, registration_number, verified_at } を返す。
 * 見つからない場合は null を返す。
 * @param {string} description
 * @param {object} [registry] - 省略時は loadVendorRegistry() を使用
 * @returns {{ vendor: string, registration_number: string|null, verified_at: string }|null}
 */
function lookupVendorRegistration(description, registry) {
  const reg = registry || loadVendorRegistry();
  const upper = String(description || '').toUpperCase();
  for (const [vendorName, info] of Object.entries(reg)) {
    if (upper.includes(vendorName.toUpperCase())) {
      return { vendor: vendorName, ...info };
    }
  }
  return null;
}

module.exports = {
  computeHash,
  loadProcessed,
  saveProcessed,
  isProcessed,
  recordProcessed,
  recentSamples,
  loadVendorRegistry,
  saveVendorRegistry,
  lookupVendorRegistration,
};
