---
vendor_name: 株式会社外注先          # 支払先の法人名または氏名(必須)
invoice_number: 2026-05-A-001        # 取引先の請求書番号(自社の発番ではない)(必須)
amount: 30000                        # 支払金額・円・整数(必須)
due_date: 2026-05-31                 # 支払期日 YYYY-MM-DD(必須)
payment_method: 銀行振込             # 振込/口座振替/カード/現金 など(必須)
category: 外注費                     # 任意。月次レポート分類用
paid: false                          # 支払完了時に true に変更
paid_at:                             # 支払完了日(任意) YYYY-MM-DD
note: ICHI ブログのデザイン外注      # 備考(任意)
---

ファイル名規約: `<vendor>-<invoice_number>.md` (空白は - に置換)
例: sample-vendor-2026-05-A-001.md

ファイル名は単なる識別子であり、消込の根拠は frontmatter が真とする。
このファイルを inputs/payables/ に置くと payments.js がリマインダー対象として読み込む。
支払完了後は paid: true に変更することで次回実行からスキップされる。
