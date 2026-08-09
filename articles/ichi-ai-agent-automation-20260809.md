---
title: "AIエージェントで業務を完全自動化する実践ガイド――LangChainとToolsで構築するマルチステップ処理"
emoji: "🤖"
type: "tech"
topics: ["LangChain","AIエージェント","業務自動化"]
published: true
---

AIエージェントという言葉を聞くと「なんとなく自律的に動くAI」というイメージを持つ方も多いと思います。私も最初はそうでした。しかし実際に手を動かして構築してみると、**LangChainのAgentとToolsの組み合わせは、業務自動化の文脈で驚くほど実践的**だと気づきました。この記事では、マルチステップの業務処理をAIエージェントで自動化する具体的な手法を、コードを交えながら解説します。

## AIエージェントとは何か――通常のLLM呼び出しとの違い

単純なLLM呼び出しは「入力→出力」の一方通行です。一方、AIエージェントは**推論→ツール選択→実行→観察→再推論**というループを繰り返します。この仕組みをReAct（Reasoning + Acting）と呼びます。

業務自動化の観点でいえば、以下のような処理が一気に扱えるようになります。

- 社内DBへの問い合わせ
- 外部APIの呼び出し
- ファイルの読み書き
- 複数ステップにまたがる条件分岐

人間が「次に何をすべきか」を判断しながら作業を進めるのと同じように、エージェントもLLMの推論能力を使って次のアクションを自律的に決定します。

## LangChainでToolsを定義する

LangChainにおけるToolとは、エージェントが呼び出せる「能力の単位」です。Pythonの関数にデコレータを付けるだけで定義できます。

以下は、社内の在庫データベースを検索するToolと、発注メールを送信するToolの例です。

```python
from langchain.tools import tool
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_react_agent
from langchain import hub

# 在庫検索ツール
@tool
def search_inventory(product_name: str) -> str:
    """指定された商品の在庫数を返す。商品名を引数に取る。"""
    # 実際はDBクエリに置き換える
    mock_db = {
        "ノートPC": 3,
        "マウス": 15,
        "キーボード": 0,
    }
    stock = mock_db.get(product_name, -1)
    if stock == -1:
        return f"{product_name} は登録されていません。"
    return f"{product_name} の在庫数: {stock}個"

# 発注メール送信ツール
@tool
def send_order_email(product_name: str, quantity: int) -> str:
    """指定された商品を指定数量だけ発注するメールを送信する。"""
    # 実際はSMTPやSendGrid等に置き換える
    print(f"[メール送信] {product_name} を {quantity}個 発注しました。")
    return f"{product_name} {quantity}個の発注メールを送信しました。"

tools = [search_inventory, send_order_email]
```

ポイントはdocstringです。LLMはこの説明文を読んで「どのToolをいつ使うか」を判断します。**docstringが曖昧だとエージェントの精度が下がる**ため、ツールの目的・引数・戻り値を簡潔かつ正確に書くことが重要です。

## エージェントを組み立てて実行する

Toolsが揃ったら、エージェント本体を構築します。LangChainではReActエージェントのプロンプトテンプレートがHub経由で提供されているので活用します。

```python
# LLMとエージェントの初期化
llm = ChatOpenAI(model="gpt-4o", temperature=0)

# ReActプロンプトの取得
prompt = hub.pull("hwchase17/react")

# エージェントの構築
agent = create_react_agent(llm, tools, prompt)
agent_executor = AgentExecutor(
    agent=agent,
    tools=tools,
    verbose=True,       # 推論ステップをログ出力
    max_iterations=5,   # 無限ループ防止
    handle_parsing_errors=True,
)

# 実行
result = agent_executor.invoke({
    "input": "キーボードの在庫を確認して、在庫が5個以下なら10個発注してください。"
})

print(result["output"])
```

`verbose=True` にすると、エージェントがどのToolを選び、何を考えたかがターミナルに出力されます。初めて動かすときはこれを眺めるだけで推論の流れが掴めて面白いです。

実行すると内部でおおよそ以下の流れが起きます。

1. LLMが「まず在庫を確認すべき」と判断し `search_inventory("キーボード")` を呼び出す
2. 結果「0個」を受け取り、「5個以下なので発注が必要」と推論
3. `send_order_email("キーボード", 10)` を呼び出す
4. 完了メッセージを最終回答として返す

人間が手動で行っていたIF分岐処理をLLMが自然言語の指示から読み取り、自律的に実行してくれます。

## 実務投入に向けた設計のポイント

### エラーハンドリングと冪等性

業務自動化では「同じ処理が二重に走らないか」が常に気になります。Toolの内部で冪等性を担保する設計（例：発注前に発注済みフラグを確認する）が不可欠です。また `handle_parsing_errors=True` を設定しておくと、LLMの出力フォーマットが崩れたときにエージェントが自己修復を試みます。

### 人間によるアプルーバルステップ

完全自動化が怖い場合は、重要なToolの実行前に人間の承認を挟む設計が有効です。ToolのロジックにSlackへの確認メッセージ送信→返信待機を組み込むだけで、**ヒューマン・イン・ザ・ループ**なワークフローが実現できます。

### コストとトークン管理

ReActループは1タスクあたり複数回のLLM呼び出しが発生します。`max_iterations` を適切に設定し、不要なループを防ぐことでコストを抑えられます。GPT-4oよりGPT-4o-miniで十分なタスクも多いため、Toolのdocstringを明確にしてモデルの軽量化を狙うのも実務的なアプローチです。

## まとめ

この記事では、LangChainのAgentとToolsを使ったマルチステップ業務自動化の実装を解説しました。要点を整理します。

- **エージェントは推論→実行→観察のループで動く**。単純なLLM呼び出しとは本質的に異なる
- **Toolのdocstringがエージェントの判断精度を左右する**。丁寧に書くことが品質向上の近道
- `verbose=True` と `max_iterations` の設定は、デバッグとコスト管理の両面で重要
- 完全自動化に不安があれば、ヒューマン・イン・ザ・ループの設計で段階的に信頼を積み上げる

AIエージェントは「魔法のように全部やってくれる」ものではなく、**設計者がToolという形で能力を丁寧に定義してはじめて力を発揮する**技術です。まずは社内の繰り返し作業を一つ選んで、Toolを2〜3個作るところから始めてみてください。意外とあっさり動いて、思わず笑顔になるはずです。