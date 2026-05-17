'use strict';
/**
 * lib/paths.js — 全部門共通パス解決モジュール (CJS)
 *
 * 環境変数で入力・状態・出力のベースディレクトリを切り替えられる。
 * 未設定時はリポジトリ直下をベースとして使用(後方互換)。
 *
 * 環境変数:
 *   INPUT_BASE_DIR  — 入力データ基底ディレクトリ (未設定: リポジトリ直下)
 *   STATE_BASE_DIR  — 状態ファイル基底ディレクトリ (未設定: リポジトリ直下)
 *   OUTPUT_BASE_DIR — 出力データ基底ディレクトリ (未設定: リポジトリ直下)
 *
 * 利用例:
 *   const { pathForInputs, pathForState, pathForOutputs } = require('../../lib/paths.js');
 *   const INVOICES_DIR  = pathForOutputs('accounting', 'invoices');
 *   const COUNTER_FILE  = pathForState('accounting', 'invoice-counter.json');
 *   const PAYABLES_DIR  = pathForInputs('accounting', 'payables');
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const repoRoot = path.resolve(__dirname, '..');

/** INPUT_BASE_DIR が設定されていればその絶対パス、未設定ならリポジトリ直下。 */
function resolveInputBase() {
  const env = process.env.INPUT_BASE_DIR;
  return env ? path.resolve(repoRoot, env) : repoRoot;
}

/** STATE_BASE_DIR が設定されていればその絶対パス、未設定ならリポジトリ直下。 */
function resolveStateBase() {
  const env = process.env.STATE_BASE_DIR;
  return env ? path.resolve(repoRoot, env) : repoRoot;
}

/** OUTPUT_BASE_DIR が設定されていればその絶対パス、未設定ならリポジトリ直下。 */
function resolveOutputBase() {
  const env = process.env.OUTPUT_BASE_DIR;
  return env ? path.resolve(repoRoot, env) : repoRoot;
}

/**
 * 部門の inputs/ パスを返す。
 * @param {string} department - 'accounting' | 'sales'
 * @param {...string} sub - サブパス
 * @returns {string}
 */
function pathForInputs(department, ...sub) {
  return path.resolve(resolveInputBase(), department, 'inputs', ...sub);
}

/**
 * 部門の state/ パスを返す。
 * @param {string} department - 'accounting' | 'sales'
 * @param {...string} sub - サブパス
 * @returns {string}
 */
function pathForState(department, ...sub) {
  return path.resolve(resolveStateBase(), department, 'state', ...sub);
}

/**
 * 部門の outputs/ パスを返す。
 * @param {string} department - 'accounting' | 'sales'
 * @param {...string} sub - サブパス
 * @returns {string}
 */
function pathForOutputs(department, ...sub) {
  return path.resolve(resolveOutputBase(), department, 'outputs', ...sub);
}

module.exports = {
  repoRoot,
  resolveInputBase,
  resolveStateBase,
  resolveOutputBase,
  pathForInputs,
  pathForState,
  pathForOutputs,
};
