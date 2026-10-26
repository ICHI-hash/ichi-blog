---
title: "GitHub Actionsで実現する完全自動化CI/CDパイプライン構築ガイド"
emoji: "⚙️"
type: "tech"
topics: ["githubactions","cicd","devops"]
published: true
---

モダンな開発現場では、CI/CDパイプラインの構築はもはや「あったらいい」ではなく「なければ困る」インフラになっています。私自身、手動デプロイの事故を何度か経験してから、GitHub Actionsを使った完全自動化に本腰を入れました。この記事では、実際のプロジェクトで使えるパイプラインの構築方法を、具体的なコードとともに解説します。

## GitHub Actionsの基本構造を理解する

GitHub Actionsは、`.github/workflows/`ディレクトリ以下にYAMLファイルを置くだけで動作します。まずは全体の構造を把握しておきましょう。

パイプラインは大きく「**ワークフロー → ジョブ → ステップ**」という階層で構成されています。

- **ワークフロー**: 1つのYAMLファイル全体。複数持てます
- **ジョブ**: ワークフロー内の処理単位。並列・直列を制御できます
- **ステップ**: ジョブ内の個々の処理。シェルコマンドやActionを実行します

特に重要なのが**トリガー**の設定です。`push`、`pull_request`、`schedule`、`workflow_dispatch`など多様なイベントをトリガーにできます。`workflow_dispatch`を使うと手動実行も可能になるので、緊急時のホットフィックスデプロイにも対応できます。

## テスト・ビルドを自動化するワークフローを書く

では実際にNode.jsプロジェクトを想定したCI用ワークフローを書いてみましょう。PRが作成・更新されるたびに自動でテストとビルドチェックが走る構成です。

```yaml
# .github/workflows/ci.yml
name: CI Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x]

    steps:
      - name: リポジトリをチェックアウト
        uses: actions/checkout@v4

      - name: Node.js ${{ matrix.node-version }} をセットアップ
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'

      - name: 依存関係をインストール
        run: npm ci

      - name: Lintを実行
        run: npm run lint

      - name: テストを実行
        run: npm test -- --coverage

      - name: カバレッジレポートをアップロード
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}

  build:
    runs-on: ubuntu-latest
    needs: test

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20.x'
          cache: 'npm'
      - run: npm ci
      - name: プロダクションビルド
        run: npm run build
      - name: ビルド成果物をアップロード
        uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: dist/
          retention-days: 7
```

ポイントがいくつかあります。`strategy.matrix`を使うことで複数のNode.jsバージョンでのテストを並列実行できます。また`needs: test`を指定することで、テストが通った場合のみビルドが実行されるという依存関係を表現しています。`npm ci`は`npm install`ではなく`npm ci`を使うのが鉄則で、`package-lock.json`通りに厳密にインストールされるため再現性が保証されます。

## デプロイを自動化するCDワークフローを構築する

CIが通ったら次はCDです。`main`ブランチへのマージをトリガーに、自動でステージング環境へデプロイし、承認後に本番環境へ展開する構成を紹介します。

```yaml
# .github/workflows/cd.yml
name: CD Pipeline

on:
  push:
    branches: [main]

env:
  AWS_REGION: ap-northeast-1
  ECR_REPOSITORY: my-app

jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    environment: staging
    outputs:
      image-tag: ${{ steps.build-image.outputs.image-tag }}

    steps:
      - uses: actions/checkout@v4

      - name: AWSクレデンシャルを設定
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: ECRにログイン
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Dockerイメージをビルド・プッシュ
        id: build-image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          echo "image-tag=$IMAGE_TAG" >> $GITHUB_OUTPUT

      - name: ステージング環境にデプロイ
        run: |
          aws ecs update-service \
            --cluster staging-cluster \
            --service my-app-service \
            --force-new-deployment

  deploy-production:
    runs-on: ubuntu-latest
    needs: deploy-staging
    environment: production  # 承認ゲートが設定されている

    steps:
      - name: 本番環境にデプロイ
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: ECSサービスを更新
        run: |
          aws ecs update-service \
            --cluster production-cluster \
            --service my-app-service \
            --force-new-deployment
```

このワークフローで特に気に入っているのが`environment`の設定です。GitHubのリポジトリ設定で`production`環境に承認者を設定しておくと、ステージングデプロイ後に指定したメンバーの承認ボタンが押されるまで本番デプロイが待機します。人間の確認を挟みつつも、実行自体は完全自動化できる絶妙なバランスです。

## セキュリティとメンテナンスのベストプラクティス

自動化を進める際にセキュリティを疎かにすると、後で痛い目を見ます。私が実践しているポイントをまとめます。

### シークレットの管理

AWSキーやAPIトークンなどの機密情報は必ず**GitHub Secrets**に登録します。リポジトリの`Settings > Secrets and variables > Actions`から設定できます。環境ごとに異なる値を使いたい場合は、**Environment Secrets**を活用すると管理しやすくなります。

また、AWSへのアクセスにはアクセスキーではなく**OIDC（OpenID Connect）**を使う方法が現在のベストプラクティスです。`aws-actions/configure-aws-credentials`アクションがOIDCに対応しており、一時的なクレデンシャルを発行できるため、長期的なシークレットの管理リスクを大幅に減らせます。

### Actionのバージョン固定

`uses: actions/checkout@v4`のようにタグを指定するのは基本ですが、さらに安全にするにはコミットSHAで固定する方法もあります。サプライチェーン攻撃への対策として、重要なワークフローでは`uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683`のように指定することを検討してください。

### Dependabotの活用

`.github/dependabot.yml`を設定することで、GitHub ActionsのActionバージョンアップを自動でPRしてくれます。手動でのバージョン追跡から解放されるので、積極的に使いましょう。

## まとめ

GitHub Actionsを使ったCI/CDパイプラインの構築について、基本構造からテスト・ビルドの自動化、デプロイの自動化、そしてセキュリティのベストプラクティスまで解説しました。

最初はシンプルなテスト自動化から始めて、徐々にデプロイまで自動化の範囲を広げていくアプローチがおすすめです。私自身、最初から完璧なパイプラインを作ろうとして挫折した経験があります。まずは`main`へのpushでテストが走るだけでも、開発体験は劇的に改善されます。

自動化への投資は、積み重なるほどに利回りが上がるものです。今日の小さな一歩が、チーム全体の生産性を長期的に底上げしてくれます。ぜひ手を動かして、自分のプロジェクトに合ったパイプラインを育てていってください。