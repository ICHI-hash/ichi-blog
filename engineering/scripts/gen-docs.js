import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPrompt } from '../lib/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DOCS_DIR = resolve(__dirname, '../outputs/docs');

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: npm run gen:docs -- --src <ソースファイルパス> [--out <出力パス>]'
  );
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      src: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
} catch (e) {
  console.error(`Error: ${e.message}`);
  printUsage();
  process.exit(1);
}

const { values: args } = parsed;

if (!args.src) {
  console.error('Error: --src は必須です。');
  printUsage();
  process.exit(1);
}

// ── Source file ────────────────────────────────────────────────────────────

const srcPath = resolve(process.cwd(), args.src);
if (!existsSync(srcPath)) {
  console.error(`Error: ソースファイルが見つかりません: ${srcPath}`);
  process.exit(1);
}

// ── Output path ────────────────────────────────────────────────────────────

const baseName = basename(srcPath, extname(srcPath));
const outPath  = args.out
  ? resolve(process.cwd(), args.out)
  : resolve(OUTPUTS_DOCS_DIR, `${baseName}.md`);

// ── Main ───────────────────────────────────────────────────────────────────

const srcContent = readFileSync(srcPath, 'utf-8');

console.log(`\nドキュメントを生成しています: ${args.src}`);
process.stdout.write('  Claude API に問い合わせ中 ... ');

const docs = await runPrompt({
  system:
    'あなたは技術ドキュメントライターです。与えられたソースの公開 API について、' +
    'README の該当節として使える Markdown を生成してください。' +
    '含める内容: 概要、関数/クラスシグネチャ、引数・戻り値、使用例。' +
    '見出しレベルは ## から開始。コードブロックは言語指定付き。日本語で書いてください',
  user: `ファイル: ${args.src}\n\n${srcContent}`,
  maxTokens: 8192,
});

console.log('完了');

// ── Write output ───────────────────────────────────────────────────────────

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, docs, 'utf-8');
console.log(`\n生成完了: ${outPath}`);
