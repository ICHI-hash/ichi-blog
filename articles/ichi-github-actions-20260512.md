---
title: "GitHub Actionsで始めるCI/CD自動化完全ガイド"
emoji: "⚙️"
type: "tech"
topics: ["githubactions","cicd","devops"]
published: true
---

GitHub Actionsを使い始めてから、私のデプロイ作業は劇的に変わりました。毎回手動でビルドして、テストして、サーバーにアップロードして……という繰り返し作業がほぼゼロになり、コードを書くことに集中できるようになったのです。この記事では、GitHub Actionsでいちから自動化パイプラインを構築する方法を、実際のコードを交えて丁寧に解説します。

## GitHub Actionsの基本構造を理解する

GitHub Actionsのワークフローは、リポジトリの `.github/workflows/` ディレクトリに置いた **YAMLファイル** で定義します。構成要素は大きく3つです。

- **Workflow（ワークフロー）**: 自動化処理全体の定義ファイル
- **Job（ジョブ）**: ワークフロー内の実行単位。並列・直列で実行可能
- **Step（ステップ）**: ジョブ内の個々のコマンドやアクション

トリガーには `push`、`pull_request`、`schedule`（cron）、`workflow_dispatch`（手動実行）など多彩な種類があります。まずはシンプルな構成を見てみましょう。

```yaml
# .github/workflows/ci.yml
name: CI Pipeline

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - name: リポジトリをチェックアウト
        uses: actions/checkout@v4

      - name: Node.js をセットアップ
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: 依存関係をインストール
        run: npm ci

      - name: テストを実行
        run: npm test

      - name: ビルドを実行
        run: npm run build
```

このワークフローは `main` または `develop` ブランチへのプッシュ、あるいは `main` へのプルリクエスト時に自動で起動します。`actions/checkout@v4` や `actions/setup-node@v4` のように、GitHubが公式に提供している **アクション** を `uses` キーで呼び出せるのが便利なところです。

## 実践：テスト・ビルド・デプロイを一本化する

CI（継続的インテグレーション）だけでなく、CD（継続的デリバリー/デプロイ）まで含めた本格的なパイプラインを組んでみましょう。ここでは Node.js アプリケーションを例に、テスト → ビルド → Vercelへのデプロイ という流れを自動化します。

ポイントは **Jobの依存関係** です。`needs` キーを使うことで「テストが通ったらビルド、ビルドが成功したらデプロイ」という直列フローを表現できます。

```yaml
# .github/workflows/deploy.yml
name: Deploy Pipeline

on:
  push:
    branches: [ main ]

env:
  NODE_VERSION: '20'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      - run: npm ci
      - run: npm test
      - run: npm run lint

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - name: ビルド成果物をアップロード
        uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: ./dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: ビルド成果物をダウンロード
        uses: actions/download-artifact@v4
        with:
          name: build-output
          path: ./dist
      - name: Vercel にデプロイ
        run: npx vercel --prod --token=${{ secrets.VERCEL_TOKEN }}
```

`${{ secrets.VERCEL_TOKEN }}` のように、機密情報は必ず **GitHub Secrets** に登録して参照します。リポジトリの「Settings > Secrets and variables > Actions」から設定できます。絶対にYAMLに直書きしないよう気をつけてください。

### Artifactを使ったジョブ間のファイル受け渡し

各ジョブは独立した実行環境（コンテナ）で動くため、ファイルをそのまま渡すことはできません。`upload-artifact` でビルド成果物を一時保存し、後続ジョブで `download-artifact` して受け取る、というパターンが基本です。

## 効率化に役立つ実践テクニック

### キャッシュで実行時間を短縮する

依存関係のインストールは毎回時間がかかります。`actions/setup-node` の `cache: 'npm'` オプションを使うと、`node_modules` を自動でキャッシュしてくれるため、2回目以降の実行が大幅に速くなります。Pythonなら `cache: 'pip'`、Rubyなら `cache: 'bundler'` が使えます。

### マトリックス戦略で複数環境を同時テスト

複数のNode.jsバージョンやOSでテストしたい場合は、`strategy.matrix` が便利です。

```yaml
jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node-version: ['18', '20', '22']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
      - run: npm ci
      - run: npm test
```

このように書くだけで、3 OS × 3バージョン = **9通りの環境** で並列テストが走ります。OSS開発や、複数環境のサポートが必要なライブラリ開発では特に重宝します。

### 条件付き実行でムダなジョブを省く

`if` 条件を使うと、特定の状況でのみジョブやステップを実行できます。例えば `if: github.ref == 'refs/heads/main'` と書けば、mainブランチへのプッシュ時だけデプロイが走るようになります。テストはすべてのブランチで走らせつつ、デプロイはmainのみ、というよく使われるパターンも簡単に実現できます。

## セキュリティとベストプラクティス

GitHub Actionsを本番運用するにあたって、私が特に意識しているポイントをまとめます。

**アクションのバージョンは必ずピン留めする**  
`uses: actions/checkout@v4` のようにメジャーバージョンを指定するのが最低限ですが、セキュリティを重視するなら `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` のようにコミットSHAで固定する方が安全です。サプライチェーン攻撃への対策になります。

**最小権限の原則を守る**  
ワークフローに付与するトークンの権限は必要最小限にしましょう。`permissions` キーでリポジトリへの書き込み権限を制限できます。

```yaml
permissions:
  contents: read
  pull-requests: write
```

**Dependabotでアクションを自動更新する**  
`.github/dependabot.yml` に `package-ecosystem: github-actions` を追加すると、利用しているアクションのバージョン更新をDependabotが自動でPRを作成して提案してくれます。メンテナンスコストを大きく削減できる設定です。

## まとめ

GitHub Actionsは、YAMLを書くだけで強力なCI/CDパイプラインを構築できる、非常に実用的なツールです。この記事でお伝えしたポイントを振り返ります。

- **基本構造**：Workflow → Job → Stepの階層でパイプラインを定義する
- **実践構成**：`needs` でJob間の依存を管理し、テスト・ビルド・デプロイを直列化する
- **効率化**：キャッシュとマトリックス戦略で高速化・並列化を実現する
- **セキュリティ**：Secrets活用・アクションのバージョン固定・最小権限設定を徹底する

最初は「YAMLの書き方が難しそう」と感じる方も多いと思いますが、公式ドキュメントやGitHub Marketplaceには豊富なサンプルがあります。まずはシンプルなテスト自動化から始めて、少しずつデプロイまで拡張していくのがおすすめです。自動化によって生まれた時間を、ぜひプロダクトの改善に使ってみてください。