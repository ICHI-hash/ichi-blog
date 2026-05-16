'use strict';
const fs   = require('fs');
const path = require('path');

/**
 * srcDir 配下を再帰的に ZIP 化して destZipPath に書き出す。
 * シンボリックリンクは追跡しない。
 * @param {string} srcDir     - 圧縮元ディレクトリ
 * @param {string} destZipPath - 出力 ZIP ファイルパス
 * @returns {Promise<{ bytes: number, fileCount: number }>}
 */
async function createZip(srcDir, destZipPath) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();

  const baseFolder = path.basename(srcDir);
  zip.addLocalFolder(srcDir, baseFolder);

  zip.writeZip(destZipPath);

  const entries   = zip.getEntries().filter(e => !e.isDirectory);
  const fileCount = entries.length;
  const bytes     = fs.statSync(destZipPath).size;

  return { bytes, fileCount };
}

module.exports = { createZip };
