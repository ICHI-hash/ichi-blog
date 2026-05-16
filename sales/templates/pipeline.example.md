---
project_name: ICHI ブランド構築         # 案件名(必須)
client_name: 株式会社サンプル           # 顧客名(必須)
stage: 提案中                           # リード / アポ / 提案中 / クロージング / 受注 / 失注
next_action: 見積書送付                 # 次のアクション(必須)
next_action_due: 2026-05-20             # YYYY-MM-DD 形式(必須。この日以前が要対応)
owner_note: 先方は予算上限 50 万円      # 担当者メモ(任意)
---

ファイル名規約: `<client>-<project>.md` (空白は - に置換)
例: sample-corp-ichi-brand.md

このファイルを sales/inputs/pipeline/ に置くと morning-reminder.js が読み込みます。
SALES_SHEET_ID が設定されている場合は Google Sheets が優先されます。
