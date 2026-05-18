'use strict';
/**
 * lib/obsidian-vault.js — Obsidian Vault パス解決モジュール (CJS)
 *
 * 環境変数:
 *   OBSIDIAN_VAULT_DIR — Vault の物理配置先 (未設定なら null)
 *
 * 利用例:
 *   const { resolveVaultDir, vaultPath } = require('../../lib/obsidian-vault.js');
 *   const dir = resolveVaultDir();  // null if not set
 *   const p   = vaultPath('01-departments', 'accounting.md');
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const repoRoot = path.resolve(__dirname, '..');

/**
 * OBSIDIAN_VAULT_DIR 環境変数を読み、絶対パス化して返す。
 * 未設定または空文字なら null を返す。
 * @returns {string|null}
 */
function resolveVaultDir() {
  const dir = (process.env.OBSIDIAN_VAULT_DIR || '').trim();
  if (!dir) return null;
  return path.resolve(repoRoot, dir);
}

/**
 * Vault 配下の絶対パスを返す。
 * resolveVaultDir() が null の場合は Error を throw する。
 * @param {...string} sub
 * @returns {string}
 */
function vaultPath(...sub) {
  const vault = resolveVaultDir();
  if (!vault) {
    throw new Error(
      'OBSIDIAN_VAULT_DIR が .env に未設定です。\n' +
      '例: OBSIDIAN_VAULT_DIR=C:/Users/yourname/Documents/ICHI-vault\n' +
      '設定後、再度 npm run obsidian:sync を実行してください。'
    );
  }
  return path.resolve(vault, ...sub);
}

module.exports = { resolveVaultDir, vaultPath };
