---
title: "受託開発とSaaS設計の両立戦略 ─ マルチテナント設計から始める再利用可能アーキテクチャ"
emoji: "🏗"
type: "tech"
topics: ["SaaS","マルチテナント","アーキテクチャ"]
published: true
---

受託案件を重ねるうちに、「このロジック、前の案件でも書いたな」という既視感に悩まされた経験はないでしょうか。私自身、受託開発とSaaSプロダクトを並走させる中で、同じ車輪を何度も発明してきました。この記事では、その反省から辿り着いた「マルチテナント設計を核にした再利用可能アーキテクチャ」の考え方を共有します。

## なぜマルチテナント設計が両立の鍵になるのか

受託開発とSaaS開発は、一見すると相反するように見えます。受託はクライアントの要件に合わせてカスタマイズするもの、SaaSは多くのユーザーに同一のプロダクトを提供するもの──そんなイメージがあるからです。

しかし逆説的なことに、マルチテナント設計を最初から取り入れると、**受託案件の資産がSaaSに転用しやすくなり、SaaSの知見が次の受託案件の品質を上げる**という好循環が生まれます。

マルチテナント設計の本質は「テナント（組織・クライアント）ごとにデータと設定を分離しながら、コードベースを共有する」ことです。受託案件でも「クライアントAとクライアントBで同じシステムを運用したい」という要件は珍しくありません。その要件に応えようとすると、自然とSaaSアーキテクチャに近づいていくのです。

## テナント識別とデータ分離の実装パターン

マルチテナント設計には大きく3つのパターンがあります。

| パターン | 概要 | 向いているケース |
|---|---|---|
| シェアードDB・シェアードスキーマ | テナントIDカラムで分離 | スタートアップ・低コスト優先 |
| シェアードDB・分離スキーマ | テナントごとにスキーマを分ける | 中規模SaaS |
| 分離DB | テナントごとにDBを用意 | 高セキュリティ要件・エンタープライズ受託 |

受託開発では「データを完全に分けてほしい」という要件が多いため、**スキーマ分離**か**DB分離**が現実的です。一方でSaaSのスタート時はコストを抑えるため**シェアードスキーマ**から始めることが多い。

私がよく採用するのは、アプリケーションレイヤーでテナントを意識しつつ、インフラレイヤーの切り替えをコンフィグで吸収するアプローチです。

```typescript
// tenant.context.ts
import { AsyncLocalStorage } from 'async_hooks';

interface TenantContext {
  tenantId: string;
  dbSchema: string;
  features: Record<string, boolean>;
}

const storage = new AsyncLocalStorage<TenantContext>();

export const TenantContextProvider = {
  run<T>(context: TenantContext, callback: () => T): T {
    return storage.run(context, callback);
  },
  get(): TenantContext {
    const ctx = storage.getStore();
    if (!ctx) throw new Error('TenantContext is not initialized');
    return ctx;
  },
};

// リポジトリ層での利用例
export class UserRepository {
  async findAll() {
    const { dbSchema } = TenantContextProvider.get();
    // スキーマをクエリに反映
    return this.db.query(`SELECT * FROM ${dbSchema}.users`);
  }
}
```

`AsyncLocalStorage`を使ってリクエストスコープでテナント情報を保持することで、サービス層やリポジトリ層がテナントを意識するコードを局所化できます。これにより、受託案件用のカスタムロジックをテナント設定として外部化しやすくなります。

## フィーチャーフラグで受託カスタマイズを吸収する

受託開発で最も頭を悩ませるのが「このクライアントだけの仕様」です。if文でクライアント名を直接判定するコードは、保守の地獄への入り口です。

ここで活きるのが**フィーチャーフラグ（Feature Flags）**です。テナントごとに有効化する機能をフラグで管理することで、コードの分岐をクリーンに保てます。

```typescript
// feature-flags.service.ts
export class FeatureFlagsService {
  private flags: Record<string, boolean>;

  constructor() {
    const { features } = TenantContextProvider.get();
    this.flags = features;
  }

  isEnabled(flag: string): boolean {
    return this.flags[flag] ?? false;
  }
}

// 利用側
export class InvoiceService {
  constructor(private readonly featureFlags: FeatureFlagsService) {}

  async generate(orderId: string) {
    const invoice = await this.buildBase(orderId);

    // 受託クライアントA向けの帳票フォーマット
    if (this.featureFlags.isEnabled('custom_invoice_format_v2')) {
      return this.applyCustomFormat(invoice);
    }

    return invoice;
  }
}
```

このパターンの利点は、受託案件で実装した「クライアントAの特殊仕様」を、将来のSaaS機能の候補として管理できることです。フラグがオンのテナントが増えれば、それはSaaSの標準機能に格上げするサインになります。

### テナント設定のストア設計

フィーチャーフラグはDBやKVSで管理します。私はPostgreSQLの`jsonb`カラムに格納することが多く、以下のようなスキーマを使います。

```sql
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,        -- サブドメイン等で識別
  db_schema   TEXT NOT NULL,
  features    JSONB NOT NULL DEFAULT '{}', -- {"custom_invoice_format_v2": true}
  settings    JSONB NOT NULL DEFAULT '{}', -- UIテーマや言語設定等
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

`features`と`settings`を分けておくのがポイントです。`features`はコードの分岐に影響するフラグ、`settings`はUIや通知先メールアドレスなど振る舞いに影響しない設定値です。この分離を守ることで、フィーチャーフラグの管理が煩雑になるのを防げます。

## 受託⇄SaaS変換を意識したディレクトリ構成

アーキテクチャの方針が決まったら、それを体現するディレクトリ構成も重要です。私がよく使うのは次のような構成です。

```
src/
├── core/               # テナント非依存のドメインロジック
│   ├── invoice/
│   └── user/
├── tenant/             # テナント管理・コンテキスト
│   ├── tenant.context.ts
│   └── feature-flags.service.ts
├── adapters/           # 外部サービス・インフラの抽象化
│   ├── db/
│   └── storage/
└── modules/            # 機能モジュール（受託カスタムはここに閉じ込める）
    ├── custom-invoice/  # クライアントA向けカスタム帳票
    └── ...
```

`core/`に置いたロジックはテナントを知らない純粋なビジネスロジックです。受託案件で生まれた「多くのクライアントに共通する処理」は、積極的に`core/`に引き上げるようにしています。逆に、特定クライアント専用の処理は`modules/`の中に閉じ込め、フィーチャーフラグでしか呼ばれないようにする。

この構成を維持することで、受託案件の納品後に「core/の資産をSaaSに持ち込む」という移植コストが大幅に下がります。

## まとめ

受託開発とSaaS設計を両立させる鍵は、最初から「複数のテナントが使う前提」で設計することです。具体的には次の3点が実践のコアになります。

1. **テナントコンテキストをアプリケーション層で一元管理する** ─ `AsyncLocalStorage`などを使いリクエストスコープで保持することで、ビジネスロジックの汚染を防ぐ
2. **受託カスタマイズはフィーチャーフラグに変換する** ─ `if (client === 'A')`ではなく`if (featureFlags.isEnabled('xxx'))`で書くことで、将来の標準化への道が開ける
3. **ドメインロジックをテナント非依存のcoreに集積する** ─ 受託案件の副産物を次の案件・SaaSへの資産に転換する

「受託で食いながらSaaSを育てる」というモデルは、スタートアップや個人開発者にとって現実的な戦略です。マルチテナント設計はそのための強力な共通基盤になります。最初は少し設計コストがかかりますが、2案件目・3案件目からその投資が確実に回収されていくのを実感できるはずです。