# 障害発生報告

## 発生日時
2026-05-11 14:32 (JST)

## 影響範囲(分かっている範囲)
- 本番 API の /users および /orders エンドポイントが 503 を返し始めた
- 影響ユーザー数: 約 1,200 名 (全ユーザーの約 60%)
- v2.15.0 デプロイ完了 (14:18 JST) の約 14 分後から発生

## エラーログ
    Error: connect ETIMEDOUT 10.0.1.45:5432
        at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1194:16)
        at Object.onceWrapper (node:events:628:26)
        at TCPConnectWrap.emit (node:events:514:28)
    
    2026-05-11T05:32:11.043Z ERROR [db-pool] Failed to acquire connection (attempt 3/3)
    2026-05-11T05:32:11.044Z ERROR [http] POST /users -> 503 ServiceUnavailable
    2026-05-11T05:32:11.126Z ERROR [http] GET /orders?user_id=9812 -> 503 ServiceUnavailable
    2026-05-11T05:32:12.201Z WARN  [db-pool] Pool exhausted: 0/20 connections available
    2026-05-11T05:32:12.350Z ERROR [db-pool] Connection timeout after 30000ms
    
    at ConnectionPool.acquire (/app/node_modules/pg-pool/index.js:192:13)
    at UserRepository.findById (/app/src/repositories/user.repository.js:45:18)
    at UserService.getUser (/app/src/services/user.service.js:23:5)
    at UserController.show (/app/src/controllers/user.controller.js:15:22)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)

## 関連情報
- デプロイ v2.14.2 → v2.15.0 直後から発生
- v2.15.0 の主な変更内容: ORM を Sequelize v6 から Prisma v5 に全面移行
- 同時刻に DB サーバーの CPU 使用率が 15% → 78% に急上昇 (Datadog 確認)
- DB 接続プールの最大接続数はデフォルト設定のまま (Prisma デフォルト: pool max 未設定)
- ロールバックはまだ実施していない
- 他チームから同時間帯の異常報告なし
