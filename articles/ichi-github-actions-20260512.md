---
title: "GitHub Actionsで実現する完全自動化CI/CDパイプライン構築ガイド"
emoji: "⚙️"
type: "tech"
topics: ["githubactions","cicd","devops"]
published: true
---

CI/CDの自動化は、現代のソフトウェア開発において欠かせない要素になっています。私がGitHub Actionsを本格的に導入してから、リリース作業にかかる時間が劇的に短縮され、ヒューマンエラーも激減しました。この記事では、実際の現場で使えるCI/CDパイプラインの構築方法を、具体的なコードとともに解説します。

## GitHub Actionsの基本的な仕組みを理解する

GitHub Actionsは、リポジトリ内の`.github/workflows/`ディレクトリにYAMLファイルを配置することで動作します。ワークフローは**イベント**（pushやpull_requestなど）をトリガーとして起動し、**ジョブ**と呼ばれる処理単位を**ステップ**として順番に実行していきます。

重要な概念を整理すると次のとおりです。

- **Workflow**：自動化処理全体の定義
- **Job**：並列または直列で実行される処理グループ
- **Step**：Jobの中で順番に実行される個々のコマンドやAction
- **Runner**：Jobを実行する仮想マシン（ubuntu-latestなど）

この仕組みを理解していると、複雑なパイプラインを設計するときにも迷いにくくなります。

## 実践的なCI設定ファイルを作る

まずはNode.jsプロジェクトを例に、プルリクエスト時に自動でテストとリントが走る基本的なCIを構築してみましょう。

```yaml
# .github/workflows/ci.yml
name: CI Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [18.x, 20.x]

    steps:
      - name: リポジトリをチェックアウト
        uses: actions/checkout@v4

      - name: Node.js ${{ matrix.node-version }} のセットアップ
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'

      - name: 依存関係のインストール
        run: npm ci

      - name: リントチェック
        run: npm run lint

      - name: テスト実行
        run: npm test -- --coverage

      - name: カバレッジレポートのアップロード
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
```

このワークフローのポイントは`matrix`戦略を使っている点です。Node.js 18と20の両方でテストを並列実行することで、バージョン互換性の問題を早期に発見できます。また`npm ci`を使うことで`package-lock.json`に基づいた厳密な依存関係のインストールが保証されます。

### キャッシュを活用してビルド時間を短縮する

`actions/setup-node`の`cache: 'npm'`オプションを指定するだけで、`node_modules`のキャッシュが自動的に有効になります。私の経験では、これだけで依存関係インストールの時間が平均60〜70秒から10秒程度に短縮されました。

## 本番デプロイまで自動化するCDパイプライン

CIが通ったら、次はデプロイまで自動化しましょう。ここではAWS S3とCloudFrontへの静的サイトデプロイを例に、mainブランチへのマージ時に自動デプロイが走る設定を紹介します。

```yaml
# .github/workflows/cd.yml
name: CD Pipeline

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    
    permissions:
      id-token: write
      contents: read

    steps:
      - name: リポジトリをチェックアウト
        uses: actions/checkout@v4

      - name: Node.jsのセットアップ
        uses: actions/setup-node@v4
        with:
          node-version: '20.x'
          cache: 'npm'

      - name: 依存関係のインストール
        run: npm ci

      - name: プロダクションビルド
        run: npm run build
        env:
          NODE_ENV: production
          VITE_API_URL: ${{ secrets.PRODUCTION_API_URL }}

      - name: AWS認証（OIDC）
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ap-northeast-1

      - name: S3へデプロイ
        run: |
          aws s3 sync dist/ s3://${{ secrets.S3_BUCKET_NAME }} \
            --delete \
            --cache-control "max-age=31536000,immutable" \
            --exclude "*.html"
          aws s3 sync dist/ s3://${{ secrets.S3_BUCKET_NAME }} \
            --delete \
            --cache-control "no-cache" \
            --include "*.html"

      - name: CloudFrontキャッシュの無効化
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ secrets.CLOUDFRONT_DISTRIBUTION_ID }} \
            --paths "/*"
```

注目してほしいのは**OIDC認証**を使っている点です。従来のようにAWSのアクセスキーをSecretに保存する方式と異なり、OIDCを使うとGitHub ActionsがAWSに対して一時的なトークンで認証できます。長期間有効なクレデンシャルをリポジトリに持たせなくて済むため、セキュリティが大幅に向上します。

また、HTMLファイルとそれ以外でキャッシュ設定を分けている点も実務では重要です。ハッシュ付きのJSやCSSは長期キャッシュ、HTMLは毎回取得させることで、デプロイ後にユーザーが古いキャッシュを参照し続ける問題を防げます。

## 品質を担保するための追加ベストプラクティス

### ブランチ保護ルールとの組み合わせ

ワークフローだけ設定しても、CIが通っていないコードをマージできてしまっては意味がありません。GitHubの**Branch protection rules**でCIの成功をマージの必須条件に設定しましょう。

設定場所は`Settings > Branches > Branch protection rules`です。`Require status checks to pass before merging`を有効にして、必須にしたいJobを指定します。

### Secretsの管理戦略

環境変数やAPIキーの管理はパイプラインのセキュリティを左右する重要な要素です。私が実践しているルールを紹介します。

- **Repository Secrets**：全ブランチで共通の値（サードパーティAPIキーなど）
- **Environment Secrets**：`production`や`staging`など環境ごとに異なる値
- **Variables**：センシティブでない設定値（リージョン名など）

環境（Environment）を使うと、特定のブランチからのみデプロイを許可する制限や、デプロイ前に承認者のレビューを必須にする**Required reviewers**機能も使えます。本番環境へのデプロイに人間の目を介在させたい場合に重宝します。

### ワークフローの実行時間を最適化する

パイプラインが遅くなると開発者のフィードバックループが長くなり、生産性に直結します。意識しておきたい最適化のポイントを挙げます。

- **並列実行**：独立したJobはデフォルトで並列実行される。依存関係は`needs`で明示する
- **早期終了**：`fail-fast: true`（matrixのデフォルト）で1つ失敗したら他を止める
- **条件実行**：`if`条件でデプロイJobをmainブランチのpushに限定する
- **キャッシュ**：npm/pip/Dockerレイヤーなどビルドごとに変わらないものは積極的にキャッシュする

## まとめ

GitHub Actionsを使ったCI/CDパイプラインの構築について、基本的な仕組みから実践的な設定まで解説しました。要点を振り返ります。

- **CI**はpush・PR時にテストとリントを自動実行し、問題を早期発見する
- **CD**はmainブランチへのマージをトリガーに本番デプロイまで自動化する
- **OIDC認証**で長期クレデンシャルを持たずにセキュアなAWS連携を実現する
- **ブランチ保護**とセットで運用することで品質ゲートとして機能させる
- **キャッシュ活用**と**並列実行**でパイプラインの実行時間を最小化する

最初から完璧なパイプラインを目指す必要はありません。まずは基本的なテスト自動化から始めて、チームの開発スタイルに合わせて少しずつ拡充していくアプローチがおすすめです。自動化の恩恵を実感できると、次第に「ここも自動化したい」というアイデアが自然と湧いてくるはずです。ぜひ自分のプロジェクトに取り入れてみてください。