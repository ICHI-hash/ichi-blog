---
title: "AIエージェントで実現する業務自動化：LangChainとTool Useで作る自律型ワークフロー"
emoji: "🤖"
type: "tech"
topics: ["AIエージェント","LangChain","業務自動化"]
published: true
---

最近、業務の中で「この繰り返し作業、AIに任せられないかな」と感じる場面が増えてきました。単なるチャットボットではなく、自分で判断してツールを使い、タスクを完了まで持っていく**AIエージェント**が、その答えになり得ます。今回は LangChain の Tool Use 機能を使って、実際に動く自律型ワークフローを構築する方法を紹介します。

## AIエージェントとは何か、なぜ今なのか

従来の RPA や単純なスクリプト自動化と AIエージェントが決定的に違う点は「**文脈を理解して次のアクションを自分で決定できる**」ところです。

たとえば「先月の売上レポートをまとめてSlackに投稿して」という曖昧な指示に対して、エージェントは以下のように自律的に動きます。

1. どのデータソースにアクセスすべきか判断する
2. 必要なツール（DBクエリ、集計関数）を選択・実行する
3. 結果を整形して Slack API を呼び出す

LLM の推論能力と外部ツールの実行能力を組み合わせた ReAct（Reasoning + Acting）パターンが、この流れを実現しています。LangChain はその実装を大幅に簡略化してくれるフレームワークです。

## LangChainでToolを定義する

まず、エージェントが使えるツールを定義します。ここでは「社内DBへのクエリ」と「Slackへの投稿」という2つのツールを作ります。

```python
from langchain.tools import tool
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate
import requests

# ツール1: 売上データを取得する（擬似的なDB問い合わせ）
@tool
def get_sales_report(month: str) -> str:
    """指定した月（YYYY-MM形式）の売上サマリーを返す"""
    # 実際はDBクエリやAPIコールに置き換える
    dummy_data = {
        "2024-11": "総売上: 1,250万円 / 件数: 342件 / 平均単価: 36,549円",
        "2024-12": "総売上: 1,480万円 / 件数: 401件 / 平均単価: 36,908円",
    }
    return dummy_data.get(month, f"{month} のデータは見つかりませんでした")

# ツール2: Slackにメッセージを投稿する
@tool
def post_to_slack(channel: str, message: str) -> str:
    """指定したSlackチャンネルにメッセージを投稿する"""
    webhook_url = "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
    payload = {"channel": channel, "text": message}
    response = requests.post(webhook_url, json=payload)
    if response.status_code == 200:
        return f"#{channel} への投稿に成功しました"
    return f"投稿に失敗しました: {response.status_code}"

tools = [get_sales_report, post_to_slack]
```

`@tool` デコレータを使うと、関数の docstring がそのままツールの説明として LLM に渡されます。**説明文の質がエージェントの判断精度に直結する**ので、ここは丁寧に書くことをおすすめします。

## エージェントを組み立てて実行する

ツールが揃ったら、エージェント本体を構成します。

```python
# プロンプトテンプレートの設定
prompt = ChatPromptTemplate.from_messages([
    ("system", "あなたは業務自動化を担当するアシスタントです。"
               "ユーザーの依頼を達成するために、適切なツールを順番に使ってください。"),
    ("human", "{input}"),
    ("placeholder", "{agent_scratchpad}"),
])

# GPT-4o を使用（Tool Calling対応モデルが必須）
llm = ChatOpenAI(model="gpt-4o", temperature=0)

# エージェントとExecutorの作成
agent = create_tool_calling_agent(llm, tools, prompt)
agent_executor = AgentExecutor(
    agent=agent,
    tools=tools,
    verbose=True,       # 思考プロセスをコンソールに表示
    max_iterations=5,   # 無限ループ防止
)

# 実際に動かす
result = agent_executor.invoke({
    "input": "2024年12月の売上レポートを取得して、#sales-reportチャンネルに投稿してください"
})

print(result["output"])
```

`verbose=True` にしておくと、エージェントがどのツールをどの順序で呼んでいるかがターミナルに出力されます。開発中はこれを必ず有効にしておくと、デバッグがかなり楽になります。

実行すると、エージェントは以下の順序で自律的に動きます。

```
> Entering new AgentExecutor chain...
  Action: get_sales_report("2024-12")
  Observation: 総売上: 1,480万円 / ...
  Action: post_to_slack("#sales-report", "【12月売上レポート】...")
  Observation: #sales-report への投稿に成功しました
> Finished chain.
```

たった数行の自然言語の指示で、データ取得から投稿まで完結しました。

## 実務で使うときに気をつけること

### エラーハンドリングと冪等性

エージェントはツールの実行に失敗すると、自動でリトライしたり別の方法を試みたりします。これは便利な反面、**Slack への二重投稿**や**DBへの重複書き込み**が起きるリスクがあります。

ツール側で冪等性を担保するか、`handle_tool_error=True` を AgentExecutor に設定してエラー時の挙動を制御するのが現実的な対策です。

### コストとレイテンシの管理

エージェントは1回のタスクで LLM を複数回呼び出します。`max_iterations` を適切に設定しないと、複雑なタスクでトークン消費が膨らみます。私のプロジェクトでは、ツール数が5個以上になったタイミングでコストが急増したので、**ツールの粒度を大きめに設計する**（細かいツールを1つにまとめる）という方針に切り替えました。

### 人間の承認ステップを挟む

完全自律は理想ですが、「削除」「送金」「外部公開」といった取り返しのつかないアクションには、必ず Human-in-the-loop を設けるべきです。LangGraph を使えば、特定のノードで処理を一時停止して人間の確認を待つフローを自然に組み込めます。

## まとめ

LangChain の Tool Use を使った AIエージェントの基本的な構築方法を、実際のコードとともに紹介しました。ポイントを整理します。

- **`@tool` デコレータ**で関数をエージェントが使えるツールに変換できる
- **docstring の質**がエージェントの判断精度を左右する
- **`verbose=True`** で思考プロセスを可視化し、デバッグを効率化する
- 冪等性・コスト・Human-in-the-loop の3点が実務運用の鍵になる

単純な繰り返し作業から始めて、徐々にツールの種類と複雑さを増やしていくのが、失敗しないエージェント導入の王道だと感じています。まずは社内の「毎週手でやっている集計作業」を1つ特定して、そこからエージェント化を試してみてください。想像以上に早く動くものが作れるはずです。