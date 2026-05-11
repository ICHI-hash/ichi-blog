import { parseArgs } from 'node:util';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPrompt } from '../lib/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '../templates');
const VALID_STACKS = ['node', 'python', 'static'];

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: npm run new-project -- --input <spec.md> --out <path> [--stack node|python|static] [--force]'
  );
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      stack: { type: 'string' },
      input: { type: 'string' },
      out:   { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    strict: true,
  });
} catch (e) {
  console.error(`Error: ${e.message}`);
  printUsage();
  process.exit(1);
}

const { values: args } = parsed;

if (!args.input) { console.error('Error: --input は必須です。'); printUsage(); process.exit(1); }
if (!args.out)   { console.error('Error: --out は必須です。');   printUsage(); process.exit(1); }

// ── Input file ─────────────────────────────────────────────────────────────

const inputPath = resolve(process.cwd(), args.input);
if (!existsSync(inputPath)) {
  console.error(`Error: 入力ファイルが見つかりません: ${inputPath}`);
  process.exit(1);
}

// ── Spec parser ────────────────────────────────────────────────────────────

function parseSpec(content) {
  const lines = content.split('\n');
  let projectName = null, customer = null, stackFromFile = null, summary = null;
  const features = [];
  let inFeatures = false;

  for (const line of lines) {
    let m;
    if ((m = line.match(/^#\s+案件:\s*(.+)/)))         { projectName   = m[1].trim(); inFeatures = false; continue; }
    if ((m = line.match(/^-\s+顧客名:\s*(.+)/)))        { customer      = m[1].trim(); inFeatures = false; continue; }
    if ((m = line.match(/^-\s+技術スタック:\s*(.+)/)))  { stackFromFile = m[1].trim(); inFeatures = false; continue; }
    if ((m = line.match(/^-\s+概要:\s*(.+)/)))          { summary       = m[1].trim(); inFeatures = false; continue; }
    if (line.match(/^-\s+主要機能:/))                   { inFeatures = true; continue; }

    if (inFeatures) {
      if ((m = line.match(/^\s+-\s+(.+)/))) { features.push(m[1].trim()); continue; }
      if (line.trim() !== '') inFeatures = false;
    }
  }
  return { projectName, customer, stackFromFile, summary, features };
}

const spec = parseSpec(readFileSync(inputPath, 'utf-8'));

if (!spec.projectName) {
  console.error('Error: 案件名を抽出できませんでした。「# 案件: <案件名>」形式で記述してください。');
  process.exit(1);
}
if (!spec.customer) {
  console.error('Error: 顧客名を抽出できませんでした。「- 顧客名: <顧客名>」形式で記述してください。');
  process.exit(1);
}

const stack = args.stack ?? spec.stackFromFile;
if (!stack) {
  console.error('Error: --stack オプションか入力ファイルの「技術スタック」が必要です。');
  process.exit(1);
}
if (!VALID_STACKS.includes(stack)) {
  console.error(`Error: 不正なスタック「${stack}」。使用可能値: ${VALID_STACKS.join(' | ')}`);
  process.exit(1);
}

// ── Output path ────────────────────────────────────────────────────────────

const outPath = resolve(process.cwd(), args.out);
if (existsSync(outPath)) {
  if (!args.force) {
    console.error(`Error: 出力先が既に存在します: ${outPath}\n       --force を指定すると上書きします。`);
    process.exit(1);
  }
  rmSync(outPath, { recursive: true, force: true });
}

// ── Template variables ─────────────────────────────────────────────────────

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^\x00-\x7F]/g, '-')
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

const variables = {
  projectName: spec.projectName,
  packageName: slugify(spec.projectName),
  customer:    spec.customer,
  summary:     spec.summary ?? '',
  features:    spec.features.map(f => `- ${f}`).join('\n'),
  year:        String(new Date().getFullYear()),
};

function applyTemplate(content) {
  return content.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
}

// ── Recursive copy with template processing ────────────────────────────────

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath  = join(src, entry);
    const isTmpl   = entry.endsWith('.tmpl');
    const destName = isTmpl ? entry.slice(0, -5) : entry;
    const destPath = join(dest, destName);

    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (isTmpl) {
      writeFileSync(destPath, applyTemplate(readFileSync(srcPath, 'utf-8')), 'utf-8');
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('\nプロジェクト生成を開始します');
console.log(`  案件名  : ${spec.projectName}`);
console.log(`  顧客名  : ${spec.customer}`);
console.log(`  スタック: ${stack}`);
console.log(`  出力先  : ${outPath}\n`);

const templateDir = join(TEMPLATES_DIR, stack);
copyDir(templateDir, outPath);
console.log('[1/3] テンプレートをコピーしました');

const readmePath = join(outPath, 'README.md');
process.stdout.write('[2/3] Claude API で README を整えています ... ');
const polished = await runPrompt({
  system: 'あなたは技術ドキュメントの編集者です。与えられた README の概要・主要機能セクションを、簡潔で読みやすい日本語に整えてください。マークダウン構造、見出しレベル、リスト形式は維持し、新たなセクションは追加しないでください',
  user: readFileSync(readmePath, 'utf-8'),
});
writeFileSync(readmePath, polished, 'utf-8');
console.log('完了');

execSync('git init', { cwd: outPath, stdio: 'pipe' });
console.log('[3/3] git init 完了');

const slug = slugify(spec.projectName);
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  生成完了: ${outPath}

  次のステップ:

    cd ${outPath}

    # GitHub にリポジトリを作成してプッシュ
    gh repo create ${slug} --private --source=. --remote=origin
    git add .
    git commit -m "chore: initial project setup"
    git push -u origin main
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
