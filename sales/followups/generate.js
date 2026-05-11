import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { callClaude } from '../lib/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SALES_ROOT = resolve(__dirname, '..');
const INPUTS_DIR = resolve(SALES_ROOT, 'inputs/followups');
const OUTPUTS_DIR = resolve(SALES_ROOT, 'outputs/followups');
const TEMPLATES_DIR = resolve(__dirname, 'templates');

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('YAML フロントマターが見つかりません');
  return { meta: parseYaml(match[1]), body: match[2].trim() };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDateJa(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function parseJsonSafe(text) {
  // コードフェンスが含まれていた場合に除去してから parse
  const cleaned = text.replace(/^```(?:json)?\r?\n?/m, '').replace(/\r?\n?```$/m, '').trim();
  return JSON.parse(cleaned);
}

function buildOutput(meta, emails) {
  const meetingDate = new Date(meta.meeting_date);
  const schedule = {
    day3:  addDays(meta.meeting_date, 3),
    day7:  addDays(meta.meeting_date, 7),
    day14: addDays(meta.meeting_date, 14),
  };

  const sections = [
    { key: 'day3',  label: '1通目（day3）',  date: schedule.day3 },
    { key: 'day7',  label: '2通目（day7）',  date: schedule.day7 },
    { key: 'day14', label: '3通目（day14）', date: schedule.day14 },
  ];

  const header = [
    `# フォローアップメール — ${meta.customer}　${meta.contact}`,
    ``,
    `商談日: ${formatDateJa(meetingDate)}　／　次アクション: ${meta.next_action}`,
    ``,
  ].join('\n');

  const bodies = sections.map(({ key, label, date }) => {
    const email = emails[key];
    return [
      `---`,
      ``,
      `## ${label} — 送信予定: ${formatDateJa(date)}`,
      ``,
      `**件名:** ${email.subject}`,
      ``,
      `**本文:**`,
      ``,
      email.body,
      ``,
    ].join('\n');
  });

  return header + bodies.join('\n');
}

async function generateFollowup(inputPath) {
  const raw = await readFile(inputPath, 'utf-8');
  const { meta, body } = parseFrontmatter(raw);

  const systemPrompt = await readFile(resolve(TEMPLATES_DIR, 'system-prompt.md'), 'utf-8');

  const userMessage = `以下の商談情報をもとに、フォローアップメール 3 通分を生成してください。

## 顧客情報
- 顧客: ${meta.customer}
- 担当者: ${meta.contact}
- 商談日: ${meta.meeting_date}
- 次アクション: ${meta.next_action}

## 商談メモ
${body}`;

  console.log(`Claude API 呼び出し中...（${meta.customer}）`);
  const responseText = await callClaude({ system: systemPrompt, user: userMessage, maxTokens: 2048 });

  let emails;
  try {
    emails = parseJsonSafe(responseText);
  } catch (e) {
    console.error('JSON パース失敗。Claude の生出力:\n', responseText);
    throw new Error(`JSON パースエラー: ${e.message}`);
  }

  const required = ['day3', 'day7', 'day14'];
  for (const key of required) {
    if (!emails[key]?.subject || !emails[key]?.body) {
      throw new Error(`出力スキーマ不正: ${key} が欠損しています`);
    }
  }

  await mkdir(OUTPUTS_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeCustomer = meta.customer.replace(/[\\/:*?"<>|]/g, '_');
  const outputPath = resolve(OUTPUTS_DIR, `${date}_${safeCustomer}.md`);

  const content = buildOutput(meta, emails);
  await writeFile(outputPath, content, 'utf-8');

  console.log(`出力: ${outputPath}`);
  console.log(`  day3  送信予定: ${formatDateJa(addDays(meta.meeting_date, 3))}  件名: ${emails.day3.subject}`);
  console.log(`  day7  送信予定: ${formatDateJa(addDays(meta.meeting_date, 7))}  件名: ${emails.day7.subject}`);
  console.log(`  day14 送信予定: ${formatDateJa(addDays(meta.meeting_date, 14))}  件名: ${emails.day14.subject}`);

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
    await generateFollowup(resolve(INPUTS_DIR, file));
  }
  console.log('\n全ファイルの処理が完了しました。');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
