import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPrompt } from '../lib/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LANG_MAP = {
  '.js':  'javascript',
  '.mjs': 'javascript',
  '.ts':  'typescript',
  '.py':  'python',
};

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: npm run gen:test -- --src <ソースファイルパス> [--out <出力パス>]'
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

const ext  = extname(srcPath).toLowerCase();
const lang = LANG_MAP[ext];
if (!lang) {
  console.error(`Error: 対応していない拡張子「${ext}」。対応: ${Object.keys(LANG_MAP).join(', ')}`);
  process.exit(1);
}

// ── Default output path ────────────────────────────────────────────────────

function defaultOut(src, language) {
  const dir  = dirname(src);
  const base = basename(src, extname(src));
  if (language === 'python') {
    // tests/ をソースの親ディレクトリの隣に配置
    return resolve(dirname(dir), 'tests', `test_${base}.py`);
  }
  return resolve(dir, `${base}.test${extname(src)}`);
}

const outPath = args.out ? resolve(process.cwd(), args.out) : defaultOut(srcPath, lang);

// ── Extract code from Claude response ─────────────────────────────────────

function extractCode(text) {
  const trimmed = text.trim();
  const m = trimmed.match(/^```[^\n]*\n([\s\S]*?)```\s*$/);
  return m ? m[1] : trimmed;
}

// ── Main ───────────────────────────────────────────────────────────────────

const srcContent = readFileSync(srcPath, 'utf-8');
const relSrc = args.src;

console.log(`\nテストを生成しています: ${relSrc}`);
console.log(`  言語  : ${lang}`);
process.stdout.write('  Claude API に問い合わせ中 ... ');

const raw = await runPrompt({
  system:
    'あなたは経験豊富なテストエンジニアです。与えられたソースの公開関数・公開クラスに対し、' +
    '正常系・異常系・境界値の観点で網羅的な unit test を生成してください。' +
    "JavaScript の場合は node:test (import { test } from 'node:test'; import assert from 'node:assert/strict') を使う。" +
    'Python の場合は pytest を使う。' +
    'コードブロックのみを返し、説明文は不要',
  user: `ファイル: ${relSrc}\n\n${srcContent}`,
  maxTokens: 8192,
});

console.log('完了');

const code = extractCode(raw);

// ── Write output ───────────────────────────────────────────────────────────

mkdirSync(dirname(outPath), { recursive: true });

let writePath = outPath;
if (existsSync(outPath)) {
  writePath = outPath + '.new';
  console.warn(`\nWarning: ${outPath} は既に存在します。`);
  console.warn(`         ${writePath} として保存します。`);
}

writeFileSync(writePath, code, 'utf-8');
console.log(`\n生成完了: ${writePath}`);
