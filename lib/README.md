# lib/ — 全部門横断共通モジュール

このディレクトリはリポジトリ全部門から利用できる共通ユーティリティを収録します。

## 収録モジュール

| ファイル | 概要 |
|---|---|
| `mailer.js` | Gmail 送信 / 受信ユーティリティ (googleapis OAuth2) |

## 設計方針

- **全モジュールは CJS (`require`)** で実装する。
  ESM 環境 (sales/ など) からは `createRequire` 経由でインポートする。
- 各部門固有のロジックは `<部門>/lib/` に置く。
- `.env` の読み込みパスは `path.resolve(__dirname, '../.env')` (リポジトリ直下)。

## 部門別ラッパー

各部門が `require` パスを固定したい場合は薄いラッパーを用意する:

| 部門ラッパー | 中身 |
|---|---|
| `accounting/lib/mailer.js` | `require('../../lib/mailer.js')` の再エクスポート |
| `sales/lib/mailer.js` | `createRequire` 経由の ESM 再エクスポート |
