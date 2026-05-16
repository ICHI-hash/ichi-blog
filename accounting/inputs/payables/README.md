# accounting/inputs/payables/

支払予定ファイルを置くディレクトリです。

## ファイル名規約

`<vendor>-<invoice_number>.md`（空白は `-` に置換）

例: `sample-vendor-2026-05-A-001.md`

ファイル名は単なる識別子です。消込・リマインダーの根拠は frontmatter が真とします。

## 注意

- このディレクトリは `.gitignore` で追跡対象外です（取引先名・金額が含まれるため）
- テンプレートは `accounting/templates/payable.example.md` を参照してください
- 支払完了後は `paid: true` に変更してください
