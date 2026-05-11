const fs = require("fs");
const path = require("path");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY が設定されていません");
  process.exit(1);
}

const CONFIG = {
  brand: "ICHI",
  tagline: "ひとりで、すべてを動かす。",
  blog_url: "https://ichi-hash.github.io/ichi-blog/",
  topics: [
    "Claude Code実践ノウハウ",
    "AIエージェント業務自動化",
    "受託開発・SaaS設計",
    "一人経営・スモールビジネス戦略",
    "GitHub Actions自動化",
    "プロンプトエンジニアリング",
    "フットサル・スポーツDX",
    "eFootball eスポーツ",
  ],
};

function getWeekTheme() {
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return CONFIG.topics[weekNum % CONFIG.topics.length];
}

async function callClaude(systemPrompt, userPrompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  const data = await response.json();
  return data.content[0].text;
}

async function generateXPosts(theme) {
  const system = `あなたはICHIというAIビジネスブランドのSNSマーケターです。必ずJSONのみで返答してください。前置き・コードブロック不要。`;
  const prompt = `今週のテーマ「${theme}」についてX(Twitter)の投稿を5本作成してください。
各投稿は140字以内、絵文字を1〜3個、末尾にハッシュタグ2〜3個。
投稿ごとに角度を変える（Tips/問いかけ/気づき/数字/ストーリー）。

以下のJSON形式のみで返答:
{"posts":[{"type":"Tips","content":"投稿本文","hashtags":["#タグ1","#タグ2"]}]}`;
  const raw = await callClaude(system, prompt);
  return JSON.parse(raw);
}

async function generateZennOutline(theme) {
  const system = `あなたはICHIブランドの技術ライターです。必ずJSONのみで返答してください。前置き・コードブロック不要。`;
  const prompt = `テーマ「${theme}」でZenn技術記事のアウトラインを作成してください。
以下のJSON形式のみで返答:
{"title":"記事タイトル","emoji":"絵文字1文字","estimated_read_min":10,"intro":"リード文200字","sections":[{"heading":"見出し","summary":"内容100字","has_code":true}],"outro":"まとめ100字","tags":["tag1","tag2","tag3"]}`;
  const raw = await callClaude(system, prompt);
  return JSON.parse(raw);
}

async function generateNoteOutline(theme) {
  const system = `あなたはICHIブランドのビジネスライターです。必ずJSONのみで返答してください。前置き・コードブロック不要。`;
  const prompt = `テーマ「${theme}」でnoteビジネス記事のアウトラインを作成してください。
以下のJSON形式のみで返答:
{"title":"記事タイトル","intro":"リード文150字","sections":[{"heading":"見出し","summary":"内容80字"}],"outro":"まとめ100字"}`;
  const raw = await callClaude(system, prompt);
  return JSON.parse(raw);
}

function saveDraft(filename, content) {
  const draftsDir = path.join(__dirname, "..", "drafts");
  if (!fs.existsSync(draftsDir)) fs.mkdirSync(draftsDir, { recursive: true });
  const filepath = path.join(draftsDir, filename);
  fs.writeFileSync(filepath, content, "utf-8");
  console.log(`  ✅ 保存: drafts/${filename}`);
}

async function main() {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const theme = process.env.THEME || getWeekTheme();

  console.log("\n🚀 ICHI コンテンツ自動生成開始");
  console.log(`📅 日付: ${dateStr}`);
  console.log(`📌 今週のテーマ: ${theme}\n`);

  try {
    console.log("⚡ [1/3] X投稿を生成中...");
    const xPosts = await generateXPosts(theme);
    const xContent = [`# X投稿 下書き — ${dateStr}\nテーマ: ${theme}\n`,
      ...xPosts.posts.map((p, i) =>
        `## 投稿 ${i+1} [${p.type}]\n${p.content}\n${p.hashtags.join(" ")}\n文字数: ${(p.content+p.hashtags.join(" ")).length}字\n`
      )].join("\n");
    saveDraft(`${dateStr}_x_posts.md`, xContent);

    console.log("⚡ [2/3] Zenn記事アウトラインを生成中...");
    const zenn = await generateZennOutline(theme);
    const zennContent = [`---\ntitle: "${zenn.title}"\nemoji: "${zenn.emoji}"\ntype: "tech"\ntopics: [${zenn.tags.map(t=>`"${t}"`).join(",")}]\npublished: false\n---\n`,
      zenn.intro,"\n---\n",
      ...zenn.sections.map(s=>`## ${s.heading}\n\n<!-- ${s.summary} -->${s.has_code?"\n\n```typescript\n// TODO: 実装\n```":""}\n`),
      `## まとめ\n\n${zenn.outro}\n\n---\n*[ICHI](${CONFIG.blog_url}) — ${CONFIG.tagline}*`
    ].join("\n");
    saveDraft(`${dateStr}_zenn_article.md`, zennContent);

    console.log("⚡ [3/3] note記事アウトラインを生成中...");
    const note = await generateNoteOutline(theme);
    const noteContent = [`# ${note.title}\n`,note.intro,"\n---\n",
      ...note.sections.map(s=>`## ${s.heading}\n\n<!-- ${s.summary} -->\n`),
      `## まとめ\n\n${note.outro}\n\n---\n*ICHIの最新情報は [X](https://x.com/ICHI_automation) でも発信しています。*`
    ].join("\n");
    saveDraft(`${dateStr}_note_article.md`, noteContent);

    const report = `# ICHI 週次コンテンツレポート\n生成日: ${dateStr}\n今週のテーマ: **${theme}**\n\n## 生成ファイル\n- X投稿5本: ${dateStr}_x_posts.md\n- Zenn記事: ${dateStr}_zenn_article.md （タイトル: ${zenn.title}）\n- note記事: ${dateStr}_note_article.md （タイトル: ${note.title}）\n\n## 今週のアクション\n- [ ] X投稿5本を確認して投稿\n- [ ] Zenn記事を本文化して公開（火曜12時）\n- [ ] note記事を本文化して公開（木曜19時）\n`;
    saveDraft(`${dateStr}_weekly_report.md`, report);

    console.log("\n✨ 生成完了！drafts/ フォルダを確認してください\n");
  } catch (err) {
    console.error("❌ エラー:", err.message);
    process.exit(1);
  }
}

main();
