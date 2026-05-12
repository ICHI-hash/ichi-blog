const { TwitterApi } = require("twitter-api-v2");
const fs = require("fs");
const path = require("path");

function createClient() {
  const required = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`❌ ${key} が設定されていません`);
      process.exit(1);
    }
  }
  return new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  });
}

function findLatestDraft() {
  const draftsDir = path.join(__dirname, "..", "drafts");
  const files = fs.readdirSync(draftsDir)
    .filter(f => f.match(/^\d{4}-\d{2}-\d{2}_x_posts\.md$/))
    .sort()
    .reverse();
  if (files.length === 0) throw new Error("X投稿ドラフトが見つかりません（drafts/*_x_posts.md）");
  return {
    draftPath: path.join(draftsDir, files[0]),
    statePath: path.join(draftsDir, files[0].replace(".md", ".posted.json")),
  };
}

function parsePosts(markdown) {
  const posts = [];
  const sections = markdown.split(/(?=^## 投稿 \d+)/m).filter(s => s.startsWith("## 投稿"));
  for (const section of sections) {
    const lines = section.split("\n");
    const typeMatch = lines[0].match(/\[(.+?)\]/);
    const type = typeMatch ? typeMatch[1] : "投稿";
    const contentLines = lines.slice(1).filter(l => l.trim() && !l.startsWith("文字数"));
    const text = contentLines.join("\n").trim();
    if (text) posts.push({ type, text });
  }
  return posts;
}

async function main() {
  const client = createClient();
  const { draftPath, statePath } = findLatestDraft();

  console.log(`\n🐦 X自動投稿`);
  console.log(`📄 ドラフト: ${path.basename(draftPath)}`);

  const posts = parsePosts(fs.readFileSync(draftPath, "utf-8"));
  console.log(`📝 投稿数: ${posts.length}本`);

  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf-8"))
    : { posted: [] };

  const nextIndex = posts.findIndex((_, i) => !state.posted.includes(i));
  if (nextIndex === -1) {
    console.log("✅ 今週の投稿はすべて完了しています");
    return;
  }

  const post = posts[nextIndex];
  console.log(`\n投稿 ${nextIndex + 1}/${posts.length} [${post.type}]`);
  console.log("─".repeat(50));
  console.log(post.text);
  console.log("─".repeat(50));

  await client.readWrite.v2.tweet(post.text);

  state.posted.push(nextIndex);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

  const remaining = posts.length - state.posted.length;
  console.log(`\n✅ 投稿完了 (残り ${remaining} 本)\n`);
}

main().catch(err => {
  console.error("❌ エラー:", err.message);
  if (err.data)   console.error("APIレスポンス:", JSON.stringify(err.data, null, 2));
  if (err.code)   console.error("コード:", err.code);
  if (err.errors) console.error("詳細:", JSON.stringify(err.errors, null, 2));
  process.exit(1);
});
