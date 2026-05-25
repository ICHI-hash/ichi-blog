---
title: "フットサル×スポーツDXで変わる競技体験：センサー・AI・クラウドで実現するスマートコート"
emoji: "⚽"
type: "tech"
topics: ["SportsTech","IoT","フットサル"]
published: true
---

スポーツの現場にテクノロジーが入り込む速度が、ここ数年で一気に加速しています。私がフットサルチームの練習データ管理を手伝うようになったのをきっかけに、センサー・AI・クラウドを組み合わせた「スマートコート」の構築に取り組みました。この記事では、その実装で得た知見を技術的に整理してお伝えします。

## スマートコートのアーキテクチャ全体像

フットサルは5対5・屋内・狭いピッチという特性上、データ密度が非常に高くなります。センサーから収集した生データをリアルタイムで処理し、コーチや選手にフィードバックするまでの流れを整理すると、次のような3層構造になります。

```
[Edge Layer]
  センサー（UWB測位 / IMU / 圧力センサー）
  ↓ MQTT / BLE
[Fog Layer]
  エッジコンピュータ（Jetson Nano）
  リアルタイム前処理・フィルタリング
  ↓ WebSocket / gRPC
[Cloud Layer]
  時系列DB（InfluxDB） + 分析基盤（Python / FastAPI）
  ダッシュボード（Grafana / React）
```

UWB（Ultra-Wideband）タグを選手のビブスに縫い付け、コート四隅に固定したアンカーで測位精度±10cm程度を実現しています。IMUセンサーはボールに内蔵し、回転数・加速度を取得します。

## センサーデータの収集と前処理

エッジ側ではMQTTブローカー（Mosquitto）を立て、各センサーからのデータを集約します。以下はJetson Nano上で動くPythonの簡略版サンプルです。

```python
import paho.mqtt.client as mqtt
import json
import numpy as np
from dataclasses import dataclass, asdict
from typing import Optional
import time

@dataclass
class PlayerPosition:
    player_id: str
    timestamp: float
    x: float
    y: float
    z: float
    speed: Optional[float] = None
    acceleration: Optional[float] = None

class PositionProcessor:
    def __init__(self, window_size: int = 5):
        self.window_size = window_size
        self.history: dict[str, list[PlayerPosition]] = {}

    def process(self, raw: dict) -> PlayerPosition:
        pos = PlayerPosition(
            player_id=raw["id"],
            timestamp=raw["ts"],
            x=raw["x"],
            y=raw["y"],
            z=raw["z"],
        )
        pid = pos.player_id
        self.history.setdefault(pid, [])
        self.history[pid].append(pos)

        # 移動平均でノイズ除去
        if len(self.history[pid]) >= 2:
            prev = self.history[pid][-2]
            dt = pos.timestamp - prev.timestamp
            if dt > 0:
                dist = np.sqrt((pos.x - prev.x)**2 + (pos.y - prev.y)**2)
                pos.speed = dist / dt  # m/s

        # ウィンドウサイズを超えたら古いデータを破棄
        if len(self.history[pid]) > self.window_size:
            self.history[pid].pop(0)

        return pos

processor = PositionProcessor()

def on_message(client, userdata, msg):
    raw = json.loads(msg.payload)
    result = processor.process(raw)
    # 次のレイヤーへ転送
    client.publish("processed/position", json.dumps(asdict(result)))

client = mqtt.Client()
client.on_message = on_message
client.connect("localhost", 1883)
client.subscribe("raw/uwb/#")
client.loop_forever()
```

移動平均によるノイズ除去はシンプルですが、フットサルのような急加速・急停止が頻発する競技では、カルマンフィルタへの置き換えも検討に値します。実際に私のチームではカルマンフィルタ適用後、速度推定の誤差が約30%改善しました。

## AIによるプレー分析：ヒートマップとパターン検出

クラウド側ではInfluxDBに蓄積した位置データを使い、Pythonで分析パイプラインを構築しています。特に実用的だったのが、**ヒートマップ生成**と**プレッシングパターンの検出**です。

### ヒートマップ生成

```python
import numpy as np
import matplotlib.pyplot as plt
from influxdb_client import InfluxDBClient

COURT_W, COURT_H = 40.0, 20.0  # フットサルコート標準サイズ (m)
GRID_SIZE = 0.5  # 50cmグリッド

def fetch_positions(player_id: str, match_id: str, client: InfluxDBClient):
    query_api = client.query_api()
    query = f'''
    from(bucket: "futsal")
      |> range(start: -30d)
      |> filter(fn: (r) => r["player_id"] == "{player_id}")
      |> filter(fn: (r) => r["match_id"] == "{match_id}")
      |> filter(fn: (r) => r["_field"] == "x" or r["_field"] == "y")
      |> pivot(rowKey:["_time"], columnKey:["_field"], valueColumn:"_value")
    '''
    tables = query_api.query(query)
    positions = [(row["x"], row["y"]) for table in tables for row in table.records]
    return positions

def generate_heatmap(positions: list[tuple[float, float]]) -> np.ndarray:
    cols = int(COURT_W / GRID_SIZE)
    rows = int(COURT_H / GRID_SIZE)
    grid = np.zeros((rows, cols))

    for x, y in positions:
        col = min(int(x / GRID_SIZE), cols - 1)
        row = min(int(y / GRID_SIZE), rows - 1)
        grid[row, col] += 1

    # ガウシアンスムージング
    from scipy.ndimage import gaussian_filter
    grid = gaussian_filter(grid, sigma=1.5)
    return grid

def plot_heatmap(grid: np.ndarray, player_id: str):
    fig, ax = plt.subplots(figsize=(12, 6))
    im = ax.imshow(grid, cmap="hot", origin="lower",
                   extent=[0, COURT_W, 0, COURT_H], aspect="equal")
    plt.colorbar(im, ax=ax, label="滞在時間（相対）")
    ax.set_title(f"選手 {player_id} ヒートマップ")
    ax.set_xlabel("コート横軸 (m)")
    ax.set_ylabel("コート縦軸 (m)")
    plt.tight_layout()
    plt.savefig(f"heatmap_{player_id}.png", dpi=150)
```

このヒートマップを試合ごとに自動生成し、Slackに投稿するワークフローを組んでいます。コーチは翌朝には前日の試合レポートを確認できるため、練習計画の修正サイクルが大幅に短縮されました。

### プレッシングパターンの検出

5人の選手間距離の平均値が閾値を下回り、かつ全員の速度が一定以上であるフレームを「プレッシング局面」として自動タグ付けします。このラベルを教師データとして、LSTMベースの時系列分類モデルを訓練することで、試合映像との同期なしに戦術分析が可能になりました。

## クラウドとダッシュボードによる可視化・共有

InfluxDB + GrafanaのスタックはスポーツDXに非常に相性が良いです。Grafanaのアノテーション機能を使えば、「この時間帯にゴールが入った」「ファウルがあった」といったイベントをタイムライン上に重ねて表示できます。

FastAPIでREST APIを立て、Reactで構築したコーチ向けダッシュボードからも参照できるようにしています。認証にはFirebase Authenticationを採用し、チームごとにデータを分離。選手自身もスマホから自分のスタッツを確認できる仕組みにしています。

データの鮮度については、試合中はWebSocketでリアルタイム更新、練習後は5分間隔のバッチ処理という使い分けで、インフラコストと体験品質のバランスを取っています。

## まとめ

フットサル×スポーツDXの取り組みを通じて、以下の点が実感できました。

- **UWB測位**は屋内スポーツの位置追跡に現時点で最も実用的な選択肢
- **エッジでの前処理**をしっかり設計することがクラウドコスト削減と低遅延の両立に直結する
- **InfluxDB + Grafana**の組み合わせは時系列スポーツデータと親和性が高く、プロトタイプを素早く立ち上げられる
- ヒートマップや戦術パターン検出といった**AIの出力を現場の言葉に翻訳する**ことが、コーチ・選手への浸透のカギ

センサーやAIはあくまで手段です。「コーチが何を知りたいか」「選手がどう動けばチームが強くなるか」という問いを起点に技術を選定することで、データが実際のプレー改善につながります。スポーツDXはまだ発展途上の領域なので、ぜひ皆さんの現場でも試してみてください。