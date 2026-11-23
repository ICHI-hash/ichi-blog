---
title: "Claude Codeを使い倒す実践ノウハウ2024：プロンプト設計からCI連携まで"
emoji: "🤖"
type: "tech"
topics: ["ClaudeCode","AI","DevTools"]
published: true
---

私がClaude Codeを本格的に使い始めてから数ヶ月が経ちました。最初は「AIにコードを書かせる」という感覚でしたが、今では**思考のパートナー**として位置づけています。この記事では、試行錯誤の末にたどり着いた実践的なノウハウを、プロンプト設計からCI連携まで体系的に共有します。

## プロンプト設計：コンテキストの渡し方が9割

Claude Codeを使いこなす上でもっとも重要なのが、いかに**適切なコンテキストを渡すか**です。「このコードを修正して」だけでは期待した結果が得られません。

私が実践しているのは、次の3要素を必ずプロンプトに含める方法です。

1. **目的**：何を達成したいのか
2. **制約**：使用言語・フレームワーク・パフォーマンス要件など
3. **現状**：既存コードや直面しているエラーの詳細

たとえばAPIクライアントのリトライ処理を書いてもらうときは、こんな形で依頼します。

```
# 依頼
TypeScript製のHTTPクライアントにリトライ処理を追加してください。

## 目的
外部APIの一時的な障害（5xx系エラー）に対して自動でリトライし、
サービスの可用性を向上させる。

## 制約
- axios 1.x を使用
- 最大3回リトライ、指数バックオフ（1s, 2s, 4s）
- 4xx系エラーはリトライしない
- TypeScriptの厳格モード対応

## 現状コード
（既存のaxiosインスタンス設定をここに貼り付ける）
```

このように構造化するだけで、生成されるコードの品質が劇的に向上します。曖昧な依頼はClaude自身も迷わせてしまうので、**仕様書を書く感覚**でプロンプトを作ることを意識しています。

### ロールプロンプトの活用

特定の専門性が必要な場面では、ロールプロンプトも効果的です。「あなたはセキュリティ審査担当のシニアエンジニアです。以下のコードを脆弱性の観点でレビューしてください」という形で依頼すると、通常のコードレビューよりも深い指摘が返ってきます。

## 反復開発パターン：一発完成を狙わない

初期のころ、私は「完璧なプロンプトで完璧なコードを一発で得る」ことを目指していました。これは間違いでした。Claude Codeとの開発は**会話型の反復プロセス**として設計するのが正解です。

私が採用している流れはこうです。

1. **スケルトン生成**：まず全体構造だけを出してもらう
2. **部分実装**：各関数・モジュールを個別に深掘りする
3. **統合レビュー**：全体を貼り付けて矛盾や改善点を聞く
4. **エッジケース確認**：「このコードで考慮できていないケースは？」と問う

特にステップ4は重要で、Claudeに自分のコードの弱点を指摘させることで、テストケースの設計にもつながります。

```typescript
// Claudeが生成した指数バックオフ付きリトライ関数の例
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function requestWithRetry<T>(
  client: AxiosInstance,
  config: AxiosRequestConfig,
  maxRetries = 3
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.request<T>(config);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status ?? 0;
        // 4xx系はリトライしない
        if (status >= 400 && status < 500) {
          throw error;
        }
      }
      lastError = error;

      if (attempt < maxRetries) {
        const backoff = Math.pow(2, attempt) * 1000;
        await sleep(backoff);
      }
    }
  }

  throw lastError;
}
```

このコードはClaudeとの数ターンのやりとりで仕上げたものです。最初の生成物にはエラー型のナローイングが甘い箇所がありましたが、「TypeScriptの型安全性の観点で改善できる点は？」と聞くことで自然に修正されました。

## CI連携：レビューボットとしての活用

Claude Codeの活用は個人開発にとどまりません。私のチームでは**GitHub ActionsからClaudeのAPIを叩く軽量レビューボット**を構築し、PRのたびに自動でフィードバックを得る仕組みを作っています。

```yaml
# .github/workflows/claude-review.yml
name: Claude Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Get diff
        id: diff
        run: |
          git diff origin/${{ github.base_ref }}...HEAD \
            -- '*.ts' '*.tsx' > diff.txt

      - name: Run Claude Review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          python scripts/claude_review.py \
            --diff diff.txt \
            --pr-number ${{ github.event.pull_request.number }} \
            --repo ${{ github.repository }}
```

`claude_review.py`の中では、差分テキストをプロンプトに組み込み、「バグの可能性・パフォーマンス・可読性・セキュリティ」の4軸でレビューするよう指示しています。結果はGitHub PRのコメントとして自動投稿されるため、レビュー漏れが大幅に減りました。

### 注意点：ハルシネーションへの対処

CI連携で重要なのは、**Claudeの出力を鵜呑みにしない設計**です。私たちは「指摘はあくまで参考意見」というラベルをボットコメントに付け、最終判断は必ず人間が行う運用にしています。特にセキュリティ関連の指摘は別途専門ツールとの併用を推奨します。

## ナレッジベース管理：プロジェクト固有の知識を渡す

大規模プロジェクトでClaudeを活用するときの課題が、**プロジェクト固有の規約や設計思想をどう伝えるか**です。毎回プロンプトに書くのは非効率なので、私は以下のような`CLAUDE_CONTEXT.md`をリポジトリに置いています。

このファイルには、コーディング規約・使用しているデザインパターン・ドメイン用語の定義・避けるべきアンチパターンなどを記述しておきます。Claude Codeのセッション開始時に「このファイルの内容を前提として以降の質問に答えてください」と渡すだけで、プロジェクトへの理解度が格段に上がります。

チームで共有することで、メンバー間のClaude活用のブレも少なくなり、生成されるコードのスタイルが統一されるという副次効果もありました。

## まとめ

Claude Codeを「コード生成機」として使うのと「開発パートナー」として使うのでは、得られる価値がまったく異なります。今回紹介したノウハウを整理すると、次の4点に集約されます。

- **プロンプトは仕様書**：目的・制約・現状の3要素を必ず含める
- **反復を前提に設計**：一発完成を狙わず、会話で品質を高める
- **CI連携で恩恵を広げる**：自動レビューボットで開発フロー全体に組み込む
- **コンテキストファイルで知識を共有**：プロジェクト固有の情報を明示的に渡す

AIツールは使い方次第で生産性への影響が大きく変わります。ぜひ自分のワークフローに合わせてアレンジしながら、Claude Codeとの開発を試してみてください。