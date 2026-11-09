---
title: "フットサル×スポーツDX：データ駆動で変わる現場運営と競技力向上の全貌"
emoji: "⚽"
type: "tech"
topics: ["スポーツDX","フットサル","機械学習"]
published: true
---

スポーツの現場とテクノロジーの交差点に立つと、まだまだ「アナログな運営」が当たり前になっているシーンに気づきます。私がフットサルチームの運営に関わるようになってから、出欠管理はLINEのスタンプ、コートの予約はExcel、試合結果はホワイトボードへの手書き——そんな状況を目の当たりにしました。この記事では、フットサルという身近なスポーツを題材に、スポーツDXの実践的な進め方と、データ駆動で変わる現場の全貌をエンジニア目線でお伝えします。

## なぜフットサルはDXの好題材なのか

フットサルは「小さなサッカー」と思われがちですが、運営視点では非常に複雑なドメインを持っています。

- **参加者管理**：固定メンバー＋ゲスト混在、出欠の流動性が高い
- **コート予約**：複数施設・複数時間帯の調整が必要
- **費用分担**：コート代・用具代のリアルタイム精算
- **戦術分析**：ポジション・得点・失点パターンの可視化

これらは一見バラバラですが、すべて「データ」として統一的に扱えます。フットサルはチーム規模がサッカーより小さく（5人制）、プロトタイプを素早く試せる点でもDX導入の実験場として最適です。

## 出欠・費用管理をAPIで自動化する

まずは最も痛点になりやすい「出欠と費用の集計」をコードで解決してみましょう。私はLINE Messaging APIとFirestoreを組み合わせて、以下のような仕組みを作りました。

```python
# LINE Webhook → Firestore へ出欠を記録するCloud Functions（Python）
import functions_framework
from google.cloud import firestore
from linebot import LineBotApi, WebhookHandler
from linebot.models import MessageEvent, TextMessage
import os, re
from datetime import datetime

line_bot_api = LineBotApi(os.environ["LINE_CHANNEL_ACCESS_TOKEN"])
handler = WebhookHandler(os.environ["LINE_CHANNEL_SECRET"])
db = firestore.Client()

@functions_framework.http
def line_webhook(request):
    signature = request.headers.get("X-Line-Signature", "")
    body = request.get_data(as_text=True)
    handler.handle(body, signature)
    return "OK"

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    text = event.message.text.strip()
    user_id = event.source.user_id

    # "参加 2025-07-20" or "欠席 2025-07-20" の形式を想定
    match = re.match(r"(参加|欠席)\s+(\d{4}-\d{2}-\d{2})", text)
    if not match:
        return

    status, date_str = match.groups()
    doc_ref = db.collection("attendance").document(f"{date_str}_{user_id}")
    doc_ref.set({
        "user_id": user_id,
        "date": date_str,
        "status": status,
        "updated_at": datetime.utcnow().isoformat()
    })

    reply = f"{date_str} の {status} を記録しました✅"
    line_bot_api.reply_message(
        event.reply_token,
        TextMessage(text=reply)
    )
```

このコードで「参加 2025-07-20」とLINEに送るだけで、Firestoreに出欠データが蓄積されます。あとは参加人数に応じてコート代を自動割り勘する集計関数を追加するだけで、費用精算の手間がほぼゼロになりました。

費用計算のロジックはこんな感じです。

```typescript
// Firestore のデータを元にコスト分担を計算する TypeScript 関数
interface AttendanceRecord {
  userId: string;
  date: string;
  status: "参加" | "欠席";
}

interface CostSummary {
  perPerson: number;
  attendees: string[];
}

function calculateCostSplit(
  records: AttendanceRecord[],
  totalCost: number,
  date: string
): CostSummary {
  const attendees = records
    .filter((r) => r.date === date && r.status === "参加")
    .map((r) => r.userId);

  if (attendees.length === 0) {
    throw new Error("参加者がいません");
  }

  const perPerson = Math.ceil(totalCost / attendees.length);

  return { perPerson, attendees };
}

// 使用例
const result = calculateCostSplit(records, 8000, "2025-07-20");
console.log(`一人あたり ${result.perPerson} 円（${result.attendees.length} 人参加）`);
// → 一人あたり 1600 円（5 人参加）
```

型定義を明示することで、バックエンド・フロントエンド間のデータ契約が明確になり、チームメンバーが増えても安心してコードを触れます。

## 試合データの収集と競技力向上への活用

出欠管理がデジタル化できたら、次のステップは「試合データの蓄積と分析」です。フットサルでは以下のデータが競技力に直結します。

### 収集すべき基本スタッツ

| カテゴリ | データ項目 | 収集タイミング |
|----------|-----------|--------------|
| 得点 | 得点者・アシスト・時間帯 | 試合後即時 |
| 失点 | 失点時の守備フォーメーション | 試合後即時 |
| パス | パス本数・成功率・エリア | ビデオ解析（後処理） |
| フィジカル | 走行距離・スプリント回数 | GPSデバイス連携 |

私のチームでは最初からすべてを計測しようとして失敗しました。**まず得点・失点・出場時間だけを3ヶ月継続**することをおすすめします。データは量より継続性です。

### ダッシュボードへの可視化

蓄積したデータはLooker StudioやMetabaseで可視化できますが、コスト・カスタマイズ性のバランスを考えると**Streamlit + BigQuery**の構成が個人・小規模チームには最適です。BigQueryの無料枠（月10GBクエリ）はフットサルチームのデータ量では当面超えません。

```python
# Streamlit で得点傾向を可視化する最小構成
import streamlit as st
import pandas as pd
from google.cloud import bigquery

@st.cache_data(ttl=300)
def load_goals(team_id: str) -> pd.DataFrame:
    client = bigquery.Client()
    query = f"""
        SELECT
          scorer_id,
          COUNT(*) AS goals,
          AVG(minute) AS avg_minute
        FROM `my_project.futsal.goals`
        WHERE team_id = '{team_id}'
        GROUP BY scorer_id
        ORDER BY goals DESC
    """
    return client.query(query).to_dataframe()

st.title("⚽ フットサル スタッツダッシュボード")
team_id = st.text_input("チームID", value="team_alpha")

if team_id:
    df = load_goals(team_id)
    st.bar_chart(df.set_index("scorer_id")["goals"])
    st.dataframe(df)
```

`@st.cache_data`でBigQueryへのリクエストをキャッシュしているため、チームメンバーが何度ページを更新しても課金は最小限に抑えられます。

## 現場導入で学んだDXの落とし穴

技術的なコードと同じくらい重要なのが、**チームへの浸透戦略**です。私が経験した失敗を共有します。

**入力コストが高いと誰も使わない**
最初にWebフォームで詳細なスタッツ入力を求めたところ、試合翌日には誰も入力しなくなりました。LINEで簡単に報告できる仕組みに変えた途端、入力率が90%超えになりました。UXは機能より先に考えるべきでした。

**管理者が一人になると属人化する**
Firestoreのルール設定、Cloud Functionsのデプロイ、ドメインの更新——これらが私一人に集中した時期があり、私が不在だとシステムが止まる状況になりました。**IaC（Terraform）とドキュメント整備**が必須です。チームの運営ドキュメントとシステムのRunbookは同じリポジトリで管理するようにしました。

**データを取るだけで活用しない**
3ヶ月スタッツを集めた後、「で、何に使うの？」となったことがあります。データ収集前に「このデータで何を決定するか」をチームで合意しておくことが重要です。たとえば「失点の多い時間帯を特定して練習メニューを変える」という仮説を先に立てることで、収集すべきデータが自然と絞られます。

## まとめ

フットサル×スポーツDXを通じて、私が得た最大の学びは「小さく始めて、データと一緒に育てる」というアプローチの重要性です。

- **Phase 1**：出欠・費用管理のデジタル化（LINE API + Firestore）
- **Phase 2**：試合スタッツの継続的収集（シンプルな入力フロー優先）
- **Phase 3**：ダッシュボードによる可視化と意思決定への活用

技術スタックより先に「誰がどの痛みを解決したいか」を明確にすること。そして、エンジニアでないチームメンバーでも使えるUXを最初から設計すること。この2点がスポーツDX成功の核心です。

フットサルで培ったノウハウはバスケットボール、バレーボール、草野球にも転用できます。あなたが関わるスポーツコミュニティでも、ぜひ「最初の一歩」を踏み出してみてください。コードはすでにここにあります。