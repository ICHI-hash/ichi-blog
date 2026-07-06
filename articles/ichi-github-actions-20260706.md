---
title: "GitHub Actionsで実現する完全自動化CI/CDパイプライン構築ガイド"
emoji: "⚙️"
type: "tech"
topics: ["GitHubActions","CI/CD","DevOps"]
published: true
---

CI/CDの自動化は、現代のソフトウェア開発において欠かせない要素になっています。私がGitHub Actionsを本格的に使い始めたのは2年ほど前ですが、それまで手動でやっていたビルド・テスト・デプロイ作業が一気に自動化されたときの感動は今でも忘れられません。この記事では、GitHub Actionsを使って実践的なCI/CDパイプラインを構築する方法を、具体的なコード例とともに解説します。

## GitHub Actionsの基本構造を理解する

GitHub Actionsのワークフローは、`.github/workflows/`ディレクトリ以下にYAMLファイルとして定義します。まずは全体の構造を把握しておくことが重要です。

ワークフローは大きく以下の3つの要素で構成されています。

- **トリガー（on）**: いつワークフローを実行するかを定義する
- **ジョブ（jobs）**: 実行する処理のまとまり
- **ステップ（steps）**: ジョブ内の個々の処理

特に理解しておきたいのが、ジョブは並列実行が基本であり、依存関係がある場合は`needs`キーワードで明示的に直列化する必要がある点です。この仕組みを正しく理解するだけで、パイプラインの設計品質がぐっと上がります。

## 実践的なCI設定ファイルを書く

では、実際にNode.jsプロジェクトを想定したCI設定ファイルを見ていきましょう。

```yaml
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
      - name: リポジトリのチェックアウト
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

      - name: ユニットテストの実行
        run: npm test -- --coverage

      - name: カバレッジレポートのアップロード
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
```

このワークフローのポイントをいくつか挙げます。まず`matrix`を使うことで、複数のNode.jsバージョンで同時にテストを実行できます。また`npm ci`を使うことで`package-lock.json`に厳密に従ったインストールが行われ、再現性が保証されます。`cache: 'npm'`の指定も忘れずに入れておくと、2回目以降の実行時間を大幅に短縮できます。

### シークレットの管理について

パスワードやAPIキーなどの機密情報は、リポジトリの「Settings > Secrets and variables > Actions」から登録し、`${{ secrets.SECRET_NAME }}`の形式で参照します。絶対にYAMLファイルに直書きしないようにしましょう。

## デプロイメントの自動化

CIが整ったら、次はCDの設定です。ここではmainブランチへのマージ時に自動でデプロイを行うワークフローを追加します。

```yaml
name: CD Pipeline

on:
  push:
    branches: [main]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    needs: [] # 必要に応じてCIジョブへの依存を追加

    environment:
      name: production
      url: https://your-app.example.com

    steps:
      - name: リポジトリのチェックアウト
        uses: actions/checkout@v4

      - name: Node.js のセットアップ
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
          NEXT_PUBLIC_API_URL: ${{ secrets.API_URL }}

      - name: デプロイの実行
        run: |
          echo "デプロイ処理をここに記述"
          # 例: AWS S3へのアップロード
          aws s3 sync ./dist s3://${{ secrets.S3_BUCKET }} --delete
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: ap-northeast-1

      - name: デプロイ通知
        if: always()
        uses: 8398a7/action-slack@v3
        with:
          status: ${{ job.status }}
          text: 'デプロイが完了しました'
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

`environment`キーワードを使うと、GitHubのEnvironments機能と連携でき、本番デプロイ前に承認フローを挟むことも可能です。チームでの運用では特に重要な機能なので、ぜひ活用してみてください。

また`if: always()`を指定したSlack通知のステップは、成功・失敗に関わらず実行されます。デプロイの成否をリアルタイムで把握するために、通知の仕組みは最初から入れておくことを強くお勧めします。

## パイプラインの最適化テクニック

CI/CDパイプラインは動けばいいというわけではなく、実行時間とコストの最適化も重要です。私が実際に効果を感じたテクニックをいくつか紹介します。

### キャッシュの積極活用

`actions/cache`アクションを使ってビルドキャッシュを保存・復元することで、実行時間を大幅に短縮できます。Node.jsの`node_modules`であれば、前述の`setup-node`の`cache`オプションで簡単に設定できます。DockerイメージやPythonのpipキャッシュなど、プロジェクトに応じて適切に設定しましょう。

### ジョブの並列化

独立したテストスイートや、リントと型チェックといった処理は、別々のジョブとして並列実行することで全体の実行時間を短縮できます。ただし並列化しすぎると管理が複雑になるため、バランスを見ながら設計することが大切です。

### コンディショナル実行

```yaml
- name: E2Eテストの実行
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  run: npm run test:e2e
```

このように`if`条件を使うことで、時間のかかるE2Eテストをmainブランチへのプッシュ時のみ実行するといった制御が可能です。プルリクエスト時は軽量なテストのみ実行し、開発者のフィードバックループを高速化できます。

### セルフホステッドランナーの検討

GitHub Actionsの無料枠はパブリックリポジトリでは無制限ですが、プライベートリポジトリでは月2,000分の制限があります。大規模プロジェクトや実行時間の長いジョブが多い場合は、自社サーバーをランナーとして使うセルフホステッドランナーの導入を検討してみてください。

## まとめ

GitHub Actionsを使ったCI/CDパイプラインの構築について、基本的な構造から実践的な設定、最適化まで一通り解説しました。最初は設定ファイルの書き方に戸惑うかもしれませんが、一度動くパイプラインができてしまえば、あとは少しずつ改善していくだけです。

重要なポイントを改めて整理すると、以下の通りです。

- **再現性の確保**: `npm ci`やバージョン固定で環境差異をなくす
- **シークレット管理**: 機密情報は必ずGitHubのSecretsに格納する
- **承認フロー**: 本番デプロイにはEnvironmentsを活用する
- **通知の仕組み**: 成否に関わらず通知を入れて可視性を高める
- **継続的な最適化**: キャッシュや並列化で実行時間を短縮する

CI/CDの自動化は一度整備してしまえば、その後の開発体験を劇的に向上させてくれます。ぜひこの記事を参考に、自分のプロジェクトに合ったパイプラインを構築してみてください。