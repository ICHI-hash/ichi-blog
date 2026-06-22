---
title: "受託開発からSaaSへ——設計思想の違いを理解して両立させる実践ガイド"
emoji: "🏗️"
type: "tech"
topics: ["SaaS","設計","マルチテナント"]
published: true
---

受託開発のプロジェクトをこなしながら、「いつか自分たちのプロダクトを作りたい」と考えているエンジニアは多いと思います。私もその一人で、数年間の受託経験を経てSaaSプロダクトの開発に関わるようになりました。

最初は「コードを書く技術は同じだろう」と楽観視していましたが、実際に取り組んでみると設計の思想が根本から違うことに気づきました。この記事では、その違いを整理しながら、両方をうまく両立させるための実践的な考え方をまとめます。

## 受託開発とSaaSの設計思想の違い

受託開発は「特定のクライアントの要件を満たすシステムを納期内に届ける」ことがゴールです。要件定義から実装・納品まで、クライアントの業務フローや既存システムに合わせて設計します。カスタマイズ性が重視されるため、柔軟に要件に応える構造になりやすい。

一方SaaSは「不特定多数のユーザーが同じコードベースで価値を得られるプロダクトを継続的に成長させる」ことがゴールです。ここに根本的な違いがあります。

| 観点 | 受託開発 | SaaS |
|------|----------|------|
| 顧客数 | 1〜数社 | 数百〜数万社 |
| 要件変更 | 都度対応 | 汎用的に吸収 |
| データ分離 | 顧客ごとにDB分離が多い | マルチテナントで共有 |
| 課金 | 一括・工数ベース | サブスクリプション |
| 運用責任 | 納品後は限定的 | 永続的 |

この表を見ると、SaaSでは「汎用性」と「マルチテナント」が設計の中核になることがわかります。

## マルチテナント設計の落とし穴

受託開発で培った「テーブル設計の自由さ」がSaaSでは裏目に出ることがあります。受託では顧客ごとにスキーマを分けたり、テーブル名に顧客IDを付与するようなアプローチが取られることもありますが、SaaSでこれをやると運用が破綻します。

SaaSのマルチテナント設計でよく使われるのが、すべてのテーブルに`tenant_id`を持たせるRow-Level方式です。

```sql
-- テナントを意識したテーブル設計
CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        VARCHAR(255) NOT NULL,
  status      VARCHAR(50) NOT NULL DEFAULT 'active',
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- tenant_idを必ず含む複合インデックス
CREATE INDEX idx_projects_tenant_id ON projects(tenant_id);
CREATE INDEX idx_projects_tenant_status ON projects(tenant_id, status);
```

ここで重要なのは、アプリケーション層でも`tenant_id`のフィルタリングを強制する仕組みを作ることです。うっかり`tenant_id`のWHEREを忘れると、他テナントのデータが見えてしまうという深刻な問題が起きます。

私が実践しているのは、リポジトリ層でテナントコンテキストを必須化するパターンです。

```typescript
// テナントコンテキストを必須にするリポジトリ基底クラス
abstract class TenantScopedRepository<T> {
  constructor(
    protected readonly db: Database,
    protected readonly tenantId: string
  ) {}

  protected baseQuery() {
    return this.db.where({ tenant_id: this.tenantId });
  }

  // サブクラスはbaseQuery()を必ず使う
  abstract findAll(): Promise<T[]>;
  abstract findById(id: string): Promise<T | null>;
}

class ProjectRepository extends TenantScopedRepository<Project> {
  async findAll(): Promise<Project[]> {
    // baseQuery()を使うことでtenant_idフィルタが自動的に付く
    return this.baseQuery()
      .from('projects')
      .where({ status: 'active' })
      .select('*');
  }

  async findById(id: string): Promise<Project | null> {
    const result = await this.baseQuery()
      .from('projects')
      .where({ id })
      .first();
    return result ?? null;
  }
}
```

このように構造で強制することで、ヒューマンエラーを防げます。受託案件では「テナントという概念がない」ことも多いため、この発想自体が馴染みにくいかもしれません。意識的に仕組みを作ることが大切です。

## 設定の柔軟性をどう設計するか

受託開発では「クライアントの要望に合わせてロジックを変更する」のが当たり前です。しかしSaaSでは、顧客ごとに別コードを書くわけにはいきません。かといって、「全員が同じ動作だけ」では差別化できず、エンタープライズ顧客を取れない。

この問題を解決するのが**フィーチャーフラグ**と**テナント設定**の組み合わせです。

```typescript
// テナントごとの設定を型安全に管理する
type TenantConfig = {
  features: {
    advancedReporting: boolean;
    apiAccess: boolean;
    customWebhooks: boolean;
  };
  limits: {
    maxProjects: number;
    maxMembersPerProject: number;
    storageGb: number;
  };
  billing: {
    plan: 'starter' | 'growth' | 'enterprise';
  };
};

// 使う側のコード
async function createProject(
  tenantId: string,
  data: CreateProjectInput
): Promise<Project> {
  const config = await getTenantConfig(tenantId);
  const currentCount = await countProjects(tenantId);

  if (currentCount >= config.limits.maxProjects) {
    throw new PlanLimitError(
      `現在のプランではプロジェクトを${config.limits.maxProjects}件までしか作成できません`
    );
  }

  return projectRepository.create(tenantId, data);
}
```

このパターンにより、プランのアップグレードは「テナント設定のレコードを更新するだけ」になります。受託案件でいう「追加機能の開発」が、SaaSでは「設定のON/OFF」で実現できるよう設計するのが理想です。

## 受託案件でSaaSの思想を活かす、その逆も

両者は対立するものではなく、相互に学べることがたくさんあります。

### 受託 → SaaSに活かせること

受託開発では「クライアントの業務をドメインとして深く理解する」経験が積めます。SaaSでも特定ドメイン（会計・HR・EC）に絞ったバーティカルSaaSを作る場合、この業務知識が強みになります。また、受託で培った「要件を整理してスコープを絞る力」は、SaaSのスプリント設計にそのまま使えます。

### SaaS → 受託に活かせること

マルチテナント設計の考え方は、将来の複数クライアントへの展開を見据えた受託案件でも役立ちます。「このシステム、将来SaaSにできないか？」と意識しながら設計すると、保守性が上がりますし、将来のビジネス展開の選択肢も広がります。フィーチャーフラグの考え方も、受託でのA/Bテストや段階リリースに応用できます。

私自身、受託案件でも`tenant_id`相当の`client_id`をすべてのテーブルに持たせる設計を採用するようになりました。将来的に同一コードで複数クライアントに提供できる構造にしておくと、追加受注のときの工数が大幅に減ります。

## まとめ

受託開発とSaaSの設計思想の違いを整理すると、以下の3点に集約されます。

1. **データ設計の粒度**：SaaSはRow-Levelのマルチテナントを構造で強制する
2. **変化への対応方法**：受託はコード変更、SaaSは設定変更で吸収する
3. **責任の時間軸**：受託は納品でひと区切り、SaaSは継続的な運用が前提

どちらが優れているということはなく、ビジネスモデルに合った設計を選ぶことが重要です。ただ、両方を経験することで「なぜこの設計にするのか」という理由が腑に落ち、設計判断の引き出しが確実に増えます。

受託でSaaSの思想を少し取り入れてみる、あるいはSaaSを作るときに受託で磨いたドメイン理解を活かす。その往来が、エンジニアとしての設計力を底上げしてくれると私は感じています。