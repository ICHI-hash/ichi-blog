---
title: "フットサル×スポーツDX：データ駆動で変わる戦術分析とチーム運営の未来"
emoji: "⚽"
type: "tech"
topics: ["SportsTech","IoT","MachineLearning"]
published: true
---

スポーツの世界でも「DX（デジタルトランスフォーメーション）」の波が押し寄せています。私が趣味でフットサルチームのコーチをしていることもあり、最近は試合データの収集・分析に本格的に取り組み始めました。この記事では、フットサルを題材にしながら、スポーツDXの具体的な実装方法と、データ駆動で変わるチーム運営の可能性についてお伝えします。

## なぜフットサルにデータ分析が有効なのか

フットサルはサッカーと比べてコートが狭く、5人対5人という少人数制です。この特性が実はデータ分析との相性を非常に良くしています。

- **プレーの濃密さ**：狭いコートで短時間に多くのプレーが発生する
- **少人数制**：各選手の貢献度が可視化しやすい
- **戦術の切り替えが明確**：プレスの発動・解除などの判断ポイントが多い

従来はコーチの経験や勘に頼っていた部分を、データで裏付けることで、選手へのフィードバックの質が格段に上がりました。

## データ収集の基本設計

まずはデータの収集基盤を作ることが出発点です。私のチームでは、試合動画をもとに手動でイベントデータを入力するシンプルな方法からスタートしました。

### イベントデータの構造設計

各プレーを「イベント」として記録します。以下はPythonのdataclassを使ったイベントモデルの例です。

```python
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Literal

EventType = Literal[
    "shot", "goal", "assist", "turnover",
    "interception", "foul", "save"
]

@dataclass
class FutsalEvent:
    event_id: str
    match_id: str
    timestamp: float          # 試合開始からの秒数
    player_id: str
    team_id: str
    event_type: EventType
    x: float                  # コート上のX座標（0〜40m）
    y: float                  # コート上のY座標（0〜20m）
    success: bool = True
    related_player_id: Optional[str] = None  # アシストや対象選手
    notes: str = ""

# 使用例
event = FutsalEvent(
    event_id="evt_001",
    match_id="match_2024_01",
    timestamp=342.5,
    player_id="player_07",
    team_id="team_ichi",
    event_type="shot",
    x=28.3,
    y=10.1,
    success=False,
    notes="GKの正面、右足シュート"
)
```

このようにイベントを構造化しておくことで、後からPandasやSQLで集計・フィルタリングが簡単になります。データ設計の段階で「何を分析したいか」を明確にしておくことが、後の分析の質を大きく左右します。

### データ蓄積にSQLiteを活用する

小規模チームなら、クラウドDBを使わずともSQLiteで十分です。

```python
import sqlite3
import json
from dataclasses import asdict

def save_event(db_path: str, event: FutsalEvent) -> None:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS events (
            event_id TEXT PRIMARY KEY,
            match_id TEXT,
            timestamp REAL,
            player_id TEXT,
            team_id TEXT,
            event_type TEXT,
            x REAL,
            y REAL,
            success INTEGER,
            related_player_id TEXT,
            notes TEXT
        )
    """)

    data = asdict(event)
    data["success"] = int(data["success"])  # boolをintに変換

    cursor.execute("""
        INSERT OR REPLACE INTO events VALUES (
            :event_id, :match_id, :timestamp, :player_id,
            :team_id, :event_type, :x, :y, :success,
            :related_player_id, :notes
        )
    """, data)

    conn.commit()
    conn.close()

def get_player_stats(db_path: str, player_id: str) -> dict:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("""
        SELECT
            event_type,
            COUNT(*) as total,
            SUM(success) as successful
        FROM events
        WHERE player_id = ?
        GROUP BY event_type
    """, (player_id,))

    stats = {
        row[0]: {"total": row[1], "successful": row[2]}
        for row in cursor.fetchall()
    }
    conn.close()
    return stats
```

このシンプルな実装だけでも、選手ごとのシュート成功率・ターンオーバー数・インターセプト数などの基本スタッツをすぐに集計できます。

## 戦術分析への応用：ヒートマップとゾーン分析

データが蓄積されてくると、いよいよ戦術的なインサイトを引き出す段階に入ります。私が特に活用しているのが**ヒートマップ**と**ゾーン別分析**です。

### シュートゾーンの可視化

MatplotlibとSeabornを使えば、どのエリアからシュートが多いか、また成功率が高いかを視覚化できます。コートを6つのゾーンに分割し、ゾーン別のシュート成功率を見ることで、「自チームはどのエリアからの得点が多いか」「相手チームのウィークポイントはどこか」が明確になります。

分析の結果、私のチームでは左サイドからの折り返しによる中央シュートの成功率が他ゾーンの2倍以上あることが判明しました。これをもとに、練習メニューに左サイドからの崩しパターンを増やしたところ、直近3試合での得点数が向上しました。感覚的に「左サイドが得意」とは思っていましたが、数字で確認できると選手全員への説明も説得力が増します。

### 選手の体力マネジメントへの活用

フットサルは運動強度が非常に高く、選手の疲労管理が重要です。タイムスタンプデータを活用すると、「試合後半のターンオーバー増加」や「特定選手の後半パフォーマンス低下」を客観的に捉えられます。これにより、選手交代のタイミングや練習負荷の調整に根拠が生まれます。

## チーム運営をDXで変える：データの民主化

技術的な実装と同じくらい大切なのが、**データをチーム全体で活用できる文化づくり**です。

分析結果をコーチだけが抱え込んでも意味がありません。私のチームでは以下の取り組みをしています。

- **週次スタッツレポートのSlack配信**：Pythonスクリプトで自動生成し、選手全員が自分のデータを確認できる
- **選手自身によるメモ入力**：試合後に各自がプレーのコンテキストをメモし、定性データとして蓄積
- **目標設定のデータ連動**：「今月のシュート成功率を60%以上にする」など、データと連動した個人目標を設定

重要なのは「データで選手を評価・批判する」のではなく、「データを使って選手が自分自身を改善する」という文化です。数字は対話のきっかけであり、目的ではありません。

また、スモールスタートも大切です。最初から完璧なシステムを目指す必要はありません。Googleスプレッドシートで手入力するところから始め、慣れてきたらPythonで自動化する、というステップアップが現実的です。

## まとめ

フットサルとスポーツDXの取り組みを通じて、私が学んだことをまとめます。

| フェーズ | やること | 使う技術 |
|---|---|---|
| 収集 | イベントデータの構造設計・入力 | Python dataclass, SQLite |
| 蓄積 | 試合・選手データの管理 | SQLite, Pandas |
| 分析 | ヒートマップ・スタッツ集計 | Matplotlib, Seaborn |
| 運用 | チームへのフィードバック | Slack API, スプレッドシート |

スポーツDXは「大きなチームや企業だけのもの」ではありません。趣味のフットサルチームでも、データを活用することで戦術の精度と選手の成長速度は確実に上がります。技術的なハードルも、今回紹介したPythonとSQLiteのレベルであれば、エンジニアなら気軽に始められるはずです。

まずは1試合分のデータを記録することから始めてみてください。数字の中に、きっとこれまで見えていなかった「勝利のヒント」が隠れています。