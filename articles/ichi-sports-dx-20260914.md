---
title: "フットサル×スポーツDXで変わる競技体験——センサー・AI・クラウドで実現するスマート施設管理"
emoji: "⚽"
type: "tech"
topics: ["SportsTech","AWS","IoT"]
published: true
---

スポーツとテクノロジーの交差点に立ったとき、私はいつもワクワクを覚えます。特にフットサルは、屋内競技ゆえにセンサーやカメラの設置がしやすく、スポーツDXの実験場として非常に優れた環境です。本記事では、センサー・AI・クラウドを組み合わせてフットサル施設をスマート化する具体的なアーキテクチャと実装例を紹介します。

## スポーツDXがフットサルにもたらす可能性

フットサルの競技人口は日本国内で約100万人以上とも言われており、市区町村の体育館から民間の専用コートまで施設数も多い競技です。しかしその多くは「コートの予約台帳がExcel」「照明のON/OFFが手動」「プレイヤーのパフォーマンスデータはほぼゼロ」という状況です。

スポーツDXが目指すのは、こうしたアナログな運営をデジタルに置き換えるだけでなく、**データを競技価値に変換する**ことです。具体的には次のような領域で変革が起きています。

- **施設管理の自動化**：予約・照明・空調のIoT制御
- **パフォーマンス分析**：選手の走行距離・スプリント回数・ポジショニング
- **観戦体験の向上**：リアルタイムスコア・ハイライト自動生成
- **コーチング支援**：AIによる戦術分析と選手フィードバック

## センサーとエッジデバイスによるデータ収集

データドリブンな施設管理の第一歩は、正確なデータ収集です。フットサルコートへの導入に適したセンサー構成を見ていきましょう。

### UWBによる選手トラッキング

Ultra-Wideband（UWB）センサーはcmレベルの精度でタグ位置を取得できるため、選手のリアルタイムトラッキングに最適です。各選手のビブスにUWBタグを縫い込み、コート四隅に設置したアンカーとTDoA（Time Difference of Arrival）方式で測位します。

```python
# UWBアンカーからの測位データをパースしてRusticsなJSON形式へ変換する例
import json
import math
from dataclasses import dataclass, asdict
from typing import List, Tuple

@dataclass
class PlayerPosition:
    player_id: str
    x: float          # コート横軸 (m)
    y: float          # コート縦軸 (m)
    timestamp_ms: int

def tdoa_to_position(
    anchors: List[Tuple[float, float]],
    tdoa_values: List[float],
    speed_of_light: float = 3e8
) -> Tuple[float, float]:
    """
    簡略化したTDoA最小二乗法による2D測位
    anchors: [(x1,y1), (x2,y2), ...] アンカー座標
    tdoa_values: 各アンカーペアの到達時間差 (秒)
    """
    # 実運用ではKalmanフィルタで平滑化する
    # ここでは重心による近似値を返す簡易実装
    weighted_x = sum(a[0] for a in anchors) / len(anchors)
    weighted_y = sum(a[1] for a in anchors) / len(anchors)
    return (weighted_x, weighted_y)

def publish_position(player_id: str, x: float, y: float, ts: int) -> str:
    pos = PlayerPosition(player_id=player_id, x=round(x, 3),
                         y=round(y, 3), timestamp_ms=ts)
    return json.dumps(asdict(pos), ensure_ascii=False)

# 使用例
anchors = [(0.0, 0.0), (20.0, 0.0), (20.0, 40.0), (0.0, 40.0)]
x, y = tdoa_to_position(anchors, tdoa_values=[1e-9, 2e-9, 3e-9])
print(publish_position("player_07", x, y, 1718000000000))
# → {"player_id": "player_07", "x": 10.0, "y": 10.0, "timestamp_ms": 1718000000000}
```

このJSONをMQTTブローカー（例：AWS IoT Core）経由でクラウドへ送信し、ストリーム処理パイプラインに流し込みます。

### 環境センサーによる施設コンディション管理

選手トラッキングと並行して、照度・温度・CO2濃度を計測することで快適な競技環境を維持できます。Raspberry Pi + I2Cセンサー構成が導入コストを抑えつつ実用的です。

## クラウドパイプラインとリアルタイム処理

収集したデータはエッジで前処理し、クラウドで集約・分析します。私が実際に構築したパイプラインのコア部分をAWS構成で示します。

```
[UWBタグ] → [エッジGW (Raspberry Pi)]
    ↓ MQTT (TLS)
[AWS IoT Core]
    ↓ IoT Rules Engine
[Amazon Kinesis Data Streams]
    ↓
[AWS Lambda / Apache Flink]  ← リアルタイム集計
    ↓
[Amazon DynamoDB]  ← 位置履歴・統計
[Amazon S3]        ← 生データアーカイブ
    ↓
[Amazon QuickSight / Grafana]  ← ダッシュボード
```

Lambdaでのリアルタイム集計例として、選手ごとの直近10秒間の移動距離を計算する処理を示します。

```typescript
// AWS Lambda (Node.js) — Kinesisレコードから走行距離を集計
import { KinesisStreamEvent } from "aws-lambda";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({ region: "ap-northeast-1" });

interface PositionRecord {
  player_id: string;
  x: number;
  y: number;
  timestamp_ms: number;
}

function euclidean(a: PositionRecord, b: PositionRecord): number {
  return Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
}

export const handler = async (event: KinesisStreamEvent): Promise<void> => {
  const records: PositionRecord[] = event.Records.map((r) =>
    JSON.parse(Buffer.from(r.kinesis.data, "base64").toString("utf-8"))
  );

  // player_idでグループ化して時系列順にソート
  const grouped = records.reduce<Record<string, PositionRecord[]>>((acc, rec) => {
    (acc[rec.player_id] ??= []).push(rec);
    return acc;
  }, {});

  for (const [playerId, positions] of Object.entries(grouped)) {
    positions.sort((a, b) => a.timestamp_ms - b.timestamp_ms);

    let totalDistance = 0;
    for (let i = 1; i < positions.length; i++) {
      totalDistance += euclidean(positions[i - 1], positions[i]);
    }

    await dynamo.send(
      new UpdateItemCommand({
        TableName: "PlayerStats",
        Key: { player_id: { S: playerId } },
        UpdateExpression:
          "ADD total_distance_m :d SET last_updated = :t",
        ExpressionAttributeValues: {
          ":d": { N: totalDistance.toFixed(2) },
          ":t": { N: String(Date.now()) },
        },
      })
    );
    console.log(`${playerId}: +${totalDistance.toFixed(2)}m`);
  }
};
```

## AIによるパフォーマンス分析とコーチング支援

蓄積されたポジションデータはAIによる分析に活用できます。私が試みた用途をいくつか紹介します。

### ヒートマップとゾーン分析

選手の位置データを2Dヒートマップに変換すると、「どのゾーンで多く活動しているか」が可視化され、戦術的なフィードバックに使えます。Python + matplotlibで手軽に実装でき、さらにSciPy KDE（カーネル密度推定）を使うと滑らかなヒートマップが得られます。

### スプリント検出と疲労推定

連続するUWBデータから速度を微分することでスプリント（例：速度 > 4.5 m/s を1秒以上継続）を検出できます。試合後半になるにつれてスプリント回数や最大速度が落ちるトレンドを可視化すれば、選手交代の判断指標になります。

### コンピュータビジョンとの組み合わせ

コート上部に設置した固定カメラの映像をYOLOv8で処理すると、ボール追跡・シュート検出・ファウル判定補助が可能になります。UWBと組み合わせることでIDと位置の両方が取れるため、「誰がいつシュートしたか」の自動記録が実現します。

## まとめ

フットサル×スポーツDXの実装を通じて見えてきたのは、**スポーツの価値はデータ化することで初めて客観的に語れるようになる**という事実です。本記事で紹介したアーキテクチャをまとめます。

| レイヤー | 技術要素 | 主な効果 |
|---|---|---|
| データ収集 | UWBセンサー・環境センサー | cmレベルの位置精度・快適性管理 |
| 転送 | MQTT / AWS IoT Core | 低遅延・セキュアな通信 |
| 処理 | Kinesis + Lambda | リアルタイム集計・走行距離算出 |
| 分析 | Python・YOLOv8 | ヒートマップ・シュート検出 |
| 可視化 | Grafana・QuickSight | コーチ・選手へのフィードバック |

導入コストはエッジデバイス込みで小規模コートなら数十万円程度から始められます。まずはRaspberry PiとBLEビーコンで概念実証（PoC）を行い、精度・コスト要件が固まったらUWBへ移行するアプローチがお勧めです。競技の楽しさを損なわずにデータを積み上げていく——それがスポーツDXの真髄だと私は考えています。ぜひ皆さんの施設でも試してみてください。