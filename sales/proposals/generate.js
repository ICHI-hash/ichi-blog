import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { mdToPdf } from 'md-to-pdf';
import { callClaude } from '../lib/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SALES_ROOT = resolve(__dirname, '..');
const INPUTS_DIR = resolve(SALES_ROOT, 'inputs/proposals');
const OUTPUTS_DIR = resolve(SALES_ROOT, 'outputs/proposals');
const TEMPLATES_DIR = resolve(__dirname, 'templates');

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('YAML フロントマターが見つかりません');
  return { meta: parseYaml(match[1]), body: match[2].trim() };
}

function yyyymmdd() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

async function generateProposal(inputPath) {
  const raw = await readFile(inputPath, 'utf-8');
  const { meta, body } = parseFrontmatter(raw);

  const [systemPrompt, css] = await Promise.all([
    readFile(resolve(TEMPLATES_DIR, 'system-prompt.md'), 'utf-8'),
    readFile(resolve(TEMPLATES_DIR, 'style.css'), 'utf-8'),
  ]);

  const userMessage = `以下の顧客情報と課題・要望をもとに、提案書を生成してください。

## 顧客情報（YAML）
\`\`\`yaml
customer: ${meta.customer}
contact: ${meta.contact}
industry: ${meta.industry}
project_title: ${meta.project_title}
budget_range: ${meta.budget_range}
deadline: ${meta.deadline}
\`\`\`

## 課題・要望（本文）
${body}

## 出力形式
以下のセクション構成で Markdown を出力してください。前置きは不要です。

# 提案書 — ${meta.project_title}
## 1. はじめに
## 2. 現状の理解
## 3. ご提案内容
## 4. 期待される効果
## 5. 実施体制とスケジュール
## 6. お見積り概算
## 7. 次のステップ`;

  console.log(`Claude API 呼び出し中...（${meta.customer} / ${meta.project_title}）`);
  const markdown = await callClaude({ system: systemPrompt, user: userMessage, maxTokens: 4096 });

  await mkdir(OUTPUTS_DIR, { recursive: true });

  const safeCustomer = meta.customer.replace(/[\\/:*?"<>|]/g, '_');
  const outputPath = resolve(OUTPUTS_DIR, `${yyyymmdd()}_${safeCustomer}.pdf`);

  const pdf = await mdToPdf(
    { content: markdown },
    {
      css,
      launch_options: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
      pdf_options: {
        format: 'A4',
        margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' },
        printBackground: true,
      },
    }
  );

  if (!pdf || !pdf.content) throw new Error('PDF の生成に失敗しました');
  await writeFile(outputPath, pdf.content);
  console.log(`出力: ${outputPath}`);
  return outputPath;
}

async function main() {
  const files = (await readdir(INPUTS_DIR)).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    console.error('入力ファイルが見つかりません:', INPUTS_DIR);
    process.exit(1);
  }
  for (const file of files) {
    console.log(`\n処理開始: ${file}`);
    await generateProposal(resolve(INPUTS_DIR, file));
  }
  console.log('\n全ファイルの処理が完了しました。');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
