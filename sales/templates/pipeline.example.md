---
project_name: ICHI ブランド構築         # 案件名(必須)
client_name: 株式会社サンプル           # 顧客名(必須)
stage: 提案中                           # リード / アポ / 提案中 / クロージング / 受注 / 失注
next_action: 見積書送付                 # 次のアクション(必須)
next_action_due: 2026-05-20             # YYYY-MM-DD 形式(必須。この日以前が要対応)
owner_note: 先方は予算上限 50 万円      # 担当者メモ(任意)

# ── 経理連携用 (stage: 受注 になったら記入。空でも可) ──────────────────
billing:
  amount: 300000                        # 税抜合計 円整数。未記入なら needs_review
  tax_rate: 10                          # 税率 (10 / 8 / mixed)
  payment_terms: 月末締め翌月末払い     # 支払条件文
  due_offset_days: 30                   # 発行日 + N 日を支払期日に (省略時 30)
  items:                                # 品目一覧(省略時は amount から 1 行自動生成)
    - name: ICHI ブランド構築コンサルティング
      qty: 1
      unit_price: 300000
      tax_rate: 10
  client_address: |                     # 請求書の宛先住所(任意)
    〒100-0001
    東京都千代田区千代田 1-1-1
    サンプルビル 5F
  client_honorific: 御中               # 敬称(デフォルト: 御中)
  withholding: false                    # 源泉徴収対象なら true
  notes: |                             # 請求書備考(任意)
    請求書記載の口座へお振込みください。
---

ファイル名規約: `<client>-<project>.md` (空白は - に置換)
例: sample-corp-ichi-brand.md

このファイルを sales/inputs/pipeline/ に置くと morning-reminder.js が読み込みます。
stage: 受注 に変更すると sync-from-sales.js が経理の請求書下書きを自動生成します。
SALES_SHEET_ID が設定されている場合は Google Sheets が優先されます。
