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

const TOPIC_SLUGS = {
  "Claude Code実践ノウハウ":     "claude-code-tips",
  "AIエージェント業務自動化":     "ai-agent-automation",
  "受託開発・SaaS設計":           "saas-design",
  "一人経営・スモールビジネス戦略": "solo-business",
  "GitHub Actions自動化":         "github-actions",
  "プロンプトエンジニアリング":   "prompt-engineering",
  "フットサル・スポーツDX":       "sports-dx",
  "eFootball eスポーツ":          "efootball-esports",
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

async function generateZennFullArticle(theme, title) {
  const system = `あなたはICHIブランドの技術ライターです。Zenn向け記事の本文のみをMarkdownで出力してください。フロントマター・冒頭タイトル行は含めないこと。`;
  const prompt = `タイトル「${title}」、テーマ「${theme}」でZenn技術記事を完全に執筆してください。

条件:
- 2000〜3000字（日本語）
- ## 見出しを3〜5個、必要に応じて ### サブ見出しも使用
- 実用的なコードブロックを2〜3個含める
- 一人称（私）、親しみやすいが技術的に正確なトーン
- 最後に「## まとめ」セクションを含める
- フロントマター・タイトル行は含めない（本文のみ）`;
  return await callClaude(system, prompt);
}

async function generateNoteFull(theme, title) {
  const system = `あなたはICHIブランドのビジネスライターです。note向けビジネス記事の本文のみを出力してください。`;
  const prompt = `タイトル「${title}」、テーマ「${theme}」でnoteビジネス記事を完全に執筆してください。

条件:
- 1500〜2500字（日本語）
- ビジネス視点・個人事業主・フリーランス向け
- ## 見出しを3〜4個使用
- 一人称（私）、読みやすく共感を呼ぶトーン
- コードブロックは不要、具体的なエピソードや数字を使う
- 最後に「## まとめ」セクションを含める
- タイトル行（# タイトル）は含めない（本文のみ）`;
  return await callClaude(system, prompt);
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
    console.log("⚡ [1/4] X投稿を生成中...");
    const xPosts = await generateXPosts(theme);
    const xContent = [`# X投稿 下書き — ${dateStr}\nテーマ: ${theme}\n`,
      ...xPosts.posts.map((p, i) =>
        `## 投稿 ${i+1} [${p.type}]\n${p.content}\n${p.hashtags.join(" ")}\n文字数: ${(p.content+p.hashtags.join(" ")).length}字\n`
      )].join("\n");
    saveDraft(`${dateStr}_x_posts.md`, xContent);

    console.log("⚡ [2/4] Zenn記事（全文）を生成中...");
    const zenn = await generateZennOutline(theme);
    const zennBody = await generateZennFullArticle(theme, zenn.title);
    const slugBase = TOPIC_SLUGS[theme] || "weekly";
    const slug = `ichi-${slugBase}-${dateStr.replace(/-/g, "")}`;
    const zennFrontmatter = `---\ntitle: "${zenn.title}"\nemoji: "${zenn.emoji}"\ntype: "tech"\ntopics: [${zenn.tags.map(t=>`"${t}"`).join(",")}]\npublished: true\n---\n\n`;
    const articlesDir = path.join(__dirname, "..", "articles");
    if (!fs.existsSync(articlesDir)) fs.mkdirSync(articlesDir, { recursive: true });
    fs.writeFileSync(path.join(articlesDir, `${slug}.md`), zennFrontmatter + zennBody, "utf-8");
    console.log(`  ✅ 保存: articles/${slug}.md （Zenn自動公開）`);
    // アウトラインも drafts に保存（レビュー用）
    const zennOutline = [`---\ntitle: "${zenn.title}"\nemoji: "${zenn.emoji}"\ntype: "tech"\ntopics: [${zenn.tags.map(t=>`"${t}"`).join(",")}]\npublished: false\n---\n`,
      zenn.intro,"\n---\n",
      ...zenn.sections.map(s=>`## ${s.heading}\n\n<!-- ${s.summary} -->${s.has_code?"\n\n```typescript\n// TODO: 実装\n```":""}\n`),
      `## まとめ\n\n${zenn.outro}\n\n---\n*[ICHI](${CONFIG.blog_url}) — ${CONFIG.tagline}*`
    ].join("\n");
    saveDraft(`${dateStr}_zenn_outline.md`, zennOutline);

    console.log("⚡ [3/4] note記事（全文）を生成中...");
    const note = await generateNoteOutline(theme);
    const noteBody = await generateNoteFull(theme, note.title);
    const noteContent = `# ${note.title}\n\n${noteBody}\n\n---\n*ICHIの最新情報は [X](https://x.com/ICHI_automation) でも発信しています。*`;
    saveDraft(`${dateStr}_note_article.md`, noteContent);

    console.log("⚡ [4/4] 週次レポートを生成中...");
    const report = [
      `# ICHI 週次コンテンツレポート`,
      `生成日: ${dateStr}`,
      `今週のテーマ: **${theme}**`,
      ``,
      `## 生成ファイル`,
      `- X投稿5本: drafts/${dateStr}_x_posts.md`,
      `- Zenn記事（全文・自動公開済み）: articles/${slug}.md`,
      `  タイトル: ${zenn.title}`,
      `- Zennアウトライン（確認用）: drafts/${dateStr}_zenn_outline.md`,
      `- note記事（全文）: drafts/${dateStr}_note_article.md`,
      `  タイトル: ${note.title}`,
      ``,
      `## 今週のアクション`,
      `- [ ] X投稿: GitHub Actionsが月〜金に1本ずつ自動投稿`,
      `- [x] Zenn: articles/ にコミット済み → Zenn連携で自動公開`,
      `- [ ] note: drafts/${dateStr}_note_article.md を https://note.com/new にコピペして公開（木曜19時推奨）`,
    ].join("\n");
    saveDraft(`${dateStr}_weekly_report.md`, report);

    console.log("\n✨ 生成完了！");
    console.log(`  📰 Zenn: articles/${slug}.md → push後に自動公開`);
    console.log(`  🐦 X: 月〜金 12:00 JST に自動投稿`);
    console.log(`  📝 note: drafts/${dateStr}_note_article.md をコピペして公開\n`);
  } catch (err) {
    console.error("❌ エラー:", err.message);
    process.exit(1);
  }
}

main();
