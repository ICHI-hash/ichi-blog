'use strict';
/**
 * accounting/scripts/obsidian-sync.js
 * Obsidian Vault のノート群を生成・同期する。
 *
 * 使い方:
 *   node accounting/scripts/obsidian-sync.js               # 通常実行
 *   node accounting/scripts/obsidian-sync.js --dry-run     # 書き込みなし、予定一覧のみ
 *   node accounting/scripts/obsidian-sync.js --verbose     # 詳細ログ
 *   node accounting/scripts/obsidian-sync.js --force       # 手書きノートも上書き
 */
const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { resolveVaultDir } = require('../../lib/obsidian-vault');
const { generateVault }   = require('../lib/obsidian-generator');

// ------------------------------------------------------------------ CLI

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun:  args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
    force:   args.includes('--force'),
  };
}

// ------------------------------------------------------------------ main

async function main() {
  const opts    = parseArgs();
  const vaultDir = resolveVaultDir();

  if (!vaultDir) {
    const msg = [
      'OBSIDIAN_VAULT_DIR が .env に未設定です。',
      '例: OBSIDIAN_VAULT_DIR=C:/Users/yourname/Documents/ICHI-vault',
      '設定後、再度 npm run obsidian:sync を実行してください。',
    ].join('\n');
    process.stderr.write(msg + '\n');
    process.exit(1);
  }

  console.log(`Obsidian Vault 同期: ${vaultDir}`);
  if (opts.dryRun) console.log('[DRY RUN] ファイルは書き込みません。');

  if (!opts.dryRun) {
    fs.mkdirSync(vaultDir, { recursive: true });
  }

  const { created, updated, skipped } = await generateVault(opts);

  if (opts.dryRun) {
    console.log(`\n生成予定ファイル (${created.length} 件):`);
    created.forEach(p => console.log(`  ${p}`));
  } else {
    console.log(`\n✅ 完了:`);
    console.log(`  新規作成: ${created.length} 件`);
    console.log(`  更新:     ${updated.length} 件`);
    console.log(`  スキップ: ${skipped.length} 件 (手書きノート)`);
    if (skipped.length > 0) {
      console.log('\n  スキップされたノート (--force で上書き可能):');
      skipped.forEach(p => console.log(`    ${p}`));
    }
    console.log(`\n  Vault: ${vaultDir}`);
    console.log('  Obsidian で Vault を開くには: File > Open folder as vault');
  }
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
