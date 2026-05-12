---
project: 在庫管理システム刷新(SAMPLE-001)
author: 佐藤 / 鈴木
updated: 2026-05-12
---

## マイルストーン一覧

### M-001: キックオフ・要件定義完了

- id: M-001
- name: キックオフ・要件定義完了
- deadline: 2026-03-31
- status: 完了
- related_projects: SAMPLE-001
- progress_note: 顧客ヒアリング 2 回実施、要件定義書 v1.0 を承認取得。スコープ・非機能要件を確定済み。
- blockers: なし

### M-002: 設計・技術選定

- id: M-002
- name: 設計・技術選定
- deadline: 2026-04-15
- status: 遅延
- related_projects: SAMPLE-001
- progress_note: 基本設計書は完成したが、ハンディターミナルの機種が未決定のためバーコードスキャンの方式選定が止まっている。フロント技術選定(React vs Vue)も結論が出ていない。期限を 2 週間超過している。
- blockers: ハンディターミナル機種の顧客側確定待ち(Q1 未解決)。フロント技術選定の社内合意が取れていない。

### M-003: バーコードスキャン入出庫機能

- id: M-003
- name: バーコードスキャン入出庫機能
- deadline: 2026-06-30
- status: 進行中
- related_projects: SAMPLE-001
- progress_note: バックエンド API(入庫・出庫・返品エンドポイント)は実装済みでユニットテスト通過。フロントエンドは未着手。バーコードスキャン連携部分は M-002 の技術選定が確定しないと着手できない状況。
- blockers: M-002 の技術選定(ハンディターミナル機種・フロント技術)が未確定。

### M-004: リアルタイム在庫照会・安全在庫アラート

- id: M-004
- name: リアルタイム在庫照会・安全在庫アラート
- deadline: 2026-05-31
- status: 進行中
- related_projects: SAMPLE-001
- progress_note: 在庫照会 API の基本実装は完了。複数拠点対応・CSV エクスポート・安全在庫アラートの実装はまだ手つかず。残タスクが多く、期限まで 3 週間を切っている。
- blockers: なし

### M-005: 棚卸し機能・初期データ移行

- id: M-005
- name: 棚卸し機能・初期データ移行
- deadline: 2026-08-15
- status: 未着手
- related_projects: SAMPLE-001
- progress_note: 着手前。顧客の Excel データ(約 3,000 品番)のクレンジング方針を事前に合意する必要がある。
- blockers: 顧客側の Excel データ提供タイミングが未定。データクレンジング方針の合意が必要。

### M-006: ベータ版リリース・UAT

- id: M-006
- name: ベータ版リリース・UAT
- deadline: 2026-09-30
- status: 未着手
- related_projects: SAMPLE-001
- progress_note: 着手前。UAT の実施体制(テスト担当・スケジュール)を顧客と合意する必要がある。M-003〜M-005 の完了が前提。
- blockers: 上流マイルストーン(M-003〜M-005)の完了が前提条件。
