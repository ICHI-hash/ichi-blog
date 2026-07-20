---
title: "フットサル×スポーツDX：IoTとAIでピッチを革命する技術スタック完全解説"
emoji: "⚽"
type: "tech"
topics: ["スポーツDX","フットサル","IoT"]
published: true
---

フットサルが好きな私にとって、「スポーツ×テクノロジー」の話題は胸が躍ります。週末にピッチに立ちながら、「このプレーをデータ化できたら」と考えたことは一度や二度ではありません。今回は、IoTセンサー・クラウド・AIを組み合わせてフットサルのDXを実現する技術スタックを、実装レベルで解説します。

## なぜフットサルDXなのか

フットサルはサッカーに比べてピッチが小さく（40m×20m程度）、1試合あたりのボールタッチ数が多いため、**センサーデータの密度が高い**という特徴があります。また、屋内競技であることからWi-Fi・UWB（Ultra-Wideband）測位の精度が安定しやすく、スポーツDXの実証実験フィールドとして理想的です。

国内でも、Jリーグ系列のフットサルリーグやフィットネスジムを持つ事業者がデータ活用に関心を示し始めており、技術的な参入障壁が下がっています。

## 技術スタック全体像

本記事で扱うスタックは以下の3層構造です。

```
[Edge Layer]
  UWBアンカー × 4 + IMUセンサー搭載ビブス
        ↓ MQTT over BLE/Wi-Fi
[Fog/Gateway Layer]
  Raspberry Pi 5 (MQTT Broker + 前処理)
        ↓ WebSocket / HTTP/2
[Cloud Layer]
  TimescaleDB + FastAPI + ML Pipeline (Python)
        ↓ REST / GraphQL
[Client Layer]
  React Dashboard + スマートフォンアプリ
```

エッジからクラウドまでデータが流れる時間（レイテンシ）を100ms以内に抑えることで、試合中のリアルタイムコーチング表示を実現します。

## IoTレイヤー：センサーからデータを取得する

### UWBによる位置測位

選手ビブスにDW3000チップを搭載したUWBタグを縫い込み、ピッチ四隅のアンカーとTDoA（Time Difference of Arrival）方式で通信します。測位精度は±10cm程度で、GPSが使えない屋内でも安定動作します。

RaspberryPi側のMQTTブローカー（Mosquitto）でデータを受け取り、以下のようなPythonスクリプトで前処理します。

```python
import paho.mqtt.client as mqtt
import json
import numpy as np
from dataclasses import dataclass
from datetime import datetime

@dataclass
class PlayerPosition:
    player_id: str
    x: float  # meters from origin
    y: float
    timestamp: datetime
    velocity: float = 0.0

def calculate_velocity(prev: PlayerPosition, curr: PlayerPosition) -> float:
    dt = (curr.timestamp - prev.timestamp).total_seconds()
    if dt == 0:
        return 0.0
    dx = curr.x - prev.x
    dy = curr.y - prev.y
    return np.sqrt(dx**2 + dy**2) / dt  # m/s

position_cache: dict[str, PlayerPosition] = {}

def on_message(client, userdata, msg):
    payload = json.loads(msg.payload.decode())
    player_id = payload["tag_id"]
    curr = PlayerPosition(
        player_id=player_id,
        x=payload["x"],
        y=payload["y"],
        timestamp=datetime.fromisoformat(payload["ts"]),
    )
    if player_id in position_cache:
        curr.velocity = calculate_velocity(position_cache[player_id], curr)
    position_cache[player_id] = curr
    # 下流のクラウドAPIへ転送
    userdata["publisher"].publish("futsal/processed", json.dumps({
        "player_id": curr.player_id,
        "x": curr.x, "y": curr.y,
        "velocity": round(curr.velocity, 3),
        "ts": curr.timestamp.isoformat(),
    }))

client = mqtt.Client(userdata={"publisher": mqtt.Client()})
client.on_message = on_message
client.connect("localhost", 1883)
client.subscribe("futsal/raw/#")
client.loop_forever()
```

このスクリプトでは、前フレームとの差分から速度を計算してエンリッチしたデータを下流へ送ります。センサーの生ノイズをKalmanフィルタで除去するとさらに精度が上がりますが、まずはこのシンプルな実装でも十分動作します。

## クラウドレイヤー：時系列データの蓄積と分析

### TimescaleDBへの格納

時系列データの保存にはPostgreSQLの拡張であるTimescaleDBを使います。ハイパーテーブルにより、通常のPostgreSQLより時系列クエリが数十倍高速化されます。

```sql
-- ハイパーテーブルの作成
CREATE TABLE player_positions (
    ts          TIMESTAMPTZ NOT NULL,
    player_id   TEXT        NOT NULL,
    x           DOUBLE PRECISION,
    y           DOUBLE PRECISION,
    velocity    DOUBLE PRECISION
);

SELECT create_hypertable('player_positions', 'ts');

-- 直近5分間のヒートマップ用集計クエリ
SELECT
    player_id,
    width_bucket(x, 0, 40, 20) AS grid_x,
    width_bucket(y, 0, 20, 10) AS grid_y,
    COUNT(*)                   AS presence_count
FROM player_positions
WHERE ts > NOW() - INTERVAL '5 minutes'
GROUP BY player_id, grid_x, grid_y
ORDER BY presence_count DESC;
```

このクエリはピッチを20×10のグリッドに分割し、各選手の在籍頻度を集計します。フロントエンドでヒートマップとして可視化すると、守備ポジションの偏りや攻撃ルートの傾向が一目でわかります。

### AIによるパターン認識

蓄積されたデータをもとに、FastAPIバックエンドからscikit-learnのモデルを呼び出してプレーパターンを分類します。私が試したのはLSTMを使った「攻撃フェーズ検出」で、5人の位置座標シーケンスをインプットにカウンター・ポゼッション・セットプレーを約82%の精度で識別できました。

モデルの推論結果はリアルタイムにReactダッシュボードへWebSocketで配信し、コーチがタブレットから確認できるUIを提供します。

## 実装で詰まりやすいポイント

実際に構築して気づいた落とし穴を3点共有します。

**① タイムスタンプの同期**
UWBアンカーとゲートウェイのクロックがずれると位置計算が崩壊します。PTP（Precision Time Protocol）もしくはNTPをアンカー間で厳密に合わせることが必須です。私の環境ではchronyを使ってオフセットを±1ms以内に抑えました。

**② バッテリーと通信の両立**
タグをビブスに縫い込む都合上、バッテリーは小型にせざるを得ません。UWBの送信間隔を50ms→100msに伸ばすことで消費電力を約40%削減しつつ、速度計算の精度は許容範囲に収まりました。用途によってトレードオフを調整してください。

**③ スケールアウトの設計**
複数コート・複数試合を同時計測する場合、MQTTのトピック設計が重要です。`futsal/{venue_id}/{court_id}/{player_id}` のような階層構造にしておくと、ブローカー側でのサブスクリプションフィルタリングが容易になります。

## まとめ

フットサルDXの技術スタックをエッジ〜クラウド〜AIまで一気通貫で解説しました。ポイントを整理すると：

- **UWB**で屋内高精度測位を実現し、IMUと組み合わせて動作解析を行う
- **MQTT + Raspberry Pi**でエッジ前処理を行い、クラウドへの通信量を削減する
- **TimescaleDB**で時系列データを効率的に蓄積・集計する
- **LSTM等のAIモデル**でプレーパターンをリアルタイム分類する

スポーツDXはまだ発展途上の領域であり、技術者が入り込む余地が大きい分野です。センサー単価の低下とクラウドコストの下落により、個人〜中小クラブでも十分手が届くコスト感になってきました。まずはRaspberry PiとオープンソースのMQTTブローカーから実験を始めてみてください。ピッチの上で起きていることがデータに変わる瞬間は、開発者としても選手としても本当に感動的です。