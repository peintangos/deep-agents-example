# LangChain Deep Agents 完全調査レポート — Zenn記事制作用

## Executive Summary

LangChain の **Deep Agents** は、2025年10月に LangChain 1.0 / LangGraph 1.0 と同時に公開されたオープンソース（MITライセンス）の「エージェントハーネス」ライブラリである。Claude Code、OpenAI Deep Research、Manus などのプロダクションシステムが共通して採用しているパターン（プランニング → サブエージェント委譲 → ファイルシステムによるコンテキスト管理）を、誰でも再現できる形にパッケージ化したものが Deep Agents の本質だ。2026年4月時点で最新版は v0.5 であり、非同期サブエージェントやマルチモーダルファイルシステムが追加されている。[^1][^2][^3][^4][^5]

***

## 1. Deep Agents とは何か

### 1.1 「エージェントハーネス」という概念

LangChain のエコシステムにおける Deep Agents の位置づけは次の三層構造で理解できる:[^6]

| レイヤー | ライブラリ | 役割 |
|----------|------------|------|
| エージェントハーネス | **deepagents** | バッテリー付きの実行環境。プランニング・メモリ・サブエージェントを内包 |
| エージェントフレームワーク | **langchain** | ツール統合、プロンプト管理、LLM抽象化 |
| エージェントランタイム | **langgraph** | ステートフルなグラフ実行、ストリーミング、Human-in-the-Loop |

`create_deep_agent()` が返すのは **LangGraph の `CompiledStateGraph`** であり、LangGraph の全機能（ストリーミング、Studio、チェックポインター）をそのまま利用できる。これは、Deep Agents が新しいランタイムや推論モデルを発明したのではなく、LangGraph の上で「便利なデフォルト設定群」を提供しているという重要な設計思想を意味する。[^7][^1]

### 1.2 なぜ Deep Agents が生まれたか

通常の LLM エージェント（AgentExecutor や単純な ReAct ループ）は、短いツール呼び出しループには十分機能する。しかし複数ステップにわたる長時間タスク（リサーチ、コーディング、多段階ワークフロー）では次の問題が発生する:[^8][^9]

- **コンテキストウィンドウの爆発的増大** — すべてのツール呼び出し結果が蓄積され、1回の実行で50万トークン以上消費するケースもある
- **コンテキストロット（Context Rot）** — コンテキストが長くなるほどモデルのパフォーマンスが劣化し、ループや幻覚が発生する
- **アドホックな計画** — 明示的な計画ツールがないと、モデルは次のステップをプロンプトから逐次推測するしかない

Deep Agents はこれらを「バーチャルファイルシステムへのオフロード」「サブエージェントへの委譲」「明示的プランニングツール」の三本柱で解決する。[^2][^9]

***

## 2. アーキテクチャと組み込みツール

### 2.1 デフォルト装備のツール群

`create_deep_agent()` を呼ぶだけで、以下のツールが自動的にエージェントに付与される:[^10][^11]

**プランニング**
- `write_todos` — タスクを離散的なステップに分解し、進捗を追跡・更新する

**ファイルシステム操作**
- `read_file`, `write_file`, `edit_file` — ファイルの読み書き・編集
- `ls`, `glob`, `grep` — ファイル一覧・検索
- `execute` — サンドボックス付きのシェルアクセス

**サブエージェント管理**
- `task` — サブエージェントを生成してコンテキストを分離した形でタスクを委譲

**コンテキスト管理（自動）**
- 大型ツール出力の自動オフロード
- 会話履歴の自動要約

### 2.2 コンテキスト管理の仕組み

Deep Agents SDK は三段階のコンテキスト圧縮戦略を持つ:[^12][^13]

1. **大型ツール出力のオフロード** — ツール応答が 20,000 トークンを超えると、自動的にファイルシステムに保存し、エージェントのコンテキストにはファイルパスと先頭10行のプレビューのみを残す
2. **大型ツール入力の切り詰め** — コンテキストがモデルのウィンドウの 85% に達すると、古いツール呼び出し（ファイル書き込み等）の内容をポインターに置換する
3. **会話履歴の要約** — 長期セッションでは、古い会話を LLM を使って要約し、プロンプト効率を維持する

***

## 3. インストールとクイックスタート

### 3.1 インストール

```bash
# Python
pip install deepagents
# または (高速インストール)
uv add deepagents

# JavaScript/TypeScript
npm install deepagents
```

`deepagents` は Python と JavaScript の両方で提供されており、JS版は LangChain.js + LangGraph.js の上に構築されている。[^14][^15]

### 3.2 最小構成のエージェント

```python
from deepagents import create_deep_agent

research_instructions = """
あなたは優秀なリサーチャーです。
徹底的なリサーチを行い、洗練されたレポートを書いてください。
"""

agent = create_deep_agent(
    system_prompt=research_instructions,
)

result = agent.invoke({
    "messages": [{"role": "user", "content": "LangGraphについて調査してください"}]
})
```

この5行のコードで、プランニング・ファイルシステム・サブエージェント生成機能を持つエージェントが完成する。[^16][^17]

### 3.3 カスタムツールとモデルの追加

```python
import os
from typing import Literal
from tavily import TavilyClient
from deepagents import create_deep_agent

tavily_client = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])

def internet_search(
    query: str,
    max_results: int = 5,
    topic: Literal["general", "news", "finance"] = "general",
) -> dict:
    """インターネット検索を実行する"""
    return tavily_client.search(query, max_results=max_results, topic=topic)

agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-6",  # モデルを自由に指定
    tools=[internet_search],
    system_prompt=research_instructions,
)
```

モデルはプロバイダー非依存で、OpenAI、Anthropic、Google など任意の tool-calling 対応モデルを利用できる。[^11]

***

## 4. 主要機能の詳細

### 4.1 サブエージェント（インライン vs 非同期）

Deep Agents のサブエージェント機能には、**v0.5** (2026年4月7日リリース) で追加された**非同期（async）サブエージェント**と、それ以前からある**インライン（同期）サブエージェント**の2種類がある:[^18][^4]

| 種別 | 動作 | ステートフル | ユースケース |
|------|------|--------------|------------|
| インラインサブエージェント | メインエージェントがブロックして待機 | × | 短い独立タスク |
| 非同期サブエージェント (v0.5) | タスクIDを即座に返し、バックグラウンドで実行 | ○ | 長時間タスク、並列処理 |

非同期サブエージェントでは、スーパーバイザーは5つの管理ツールを使って生存確認・追加指示・キャンセルを行う:[^19]
- `start_async_task` — タスク開始
- `check_async_task` — 進捗確認
- `update_async_task` — 追加指示
- `cancel_async_task` — キャンセル
- `list_async_tasks` — 一覧確認

```python
# サブエージェントの定義例
research_subagent = {
    "name": "research-agent",
    "description": "詳細なリサーチを行う専門エージェント",
    "system_prompt": "あなたは優れたリサーチャーです",
    "tools": [internet_search],
    "model": "openai:gpt-4.1",  # メインと異なるモデルも指定可能
}

agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-6",
    subagents=[research_subagent]
)
```

### 4.2 メモリシステム（短期 vs 長期）

Deep Agents はファイルシステムをメモリの抽象化として利用する独自のアーキテクチャを採用している:[^20][^21]

```python
from deepagents import create_deep_agent
from langgraph.store.memory import InMemoryStore

store = InMemoryStore()  # 任意の LangGraph Store

agent = create_deep_agent(
    store=store,
    use_longterm_memory=True
)
```

- **短期メモリ**: 通常のパス（例: `/draft.txt`）に書かれたファイルは、スレッド内のみ有効。セッション終了後に消去される
- **長期メモリ**: `/memories/` プレフィックスのパス（例: `/memories/preferences.txt`）はセッションをまたいで永続化される
- **CompositeBackend**: 異なるパスを異なるバックエンドにルーティングできる（例: `/memories/` は S3、その他はローカル）[^22][^23]

### 4.3 スキル（Skills）

2025年11月に追加されたスキル機能は、Anthropic が提唱した「エージェントスキル」の概念を取り入れたもので、**段階的開示（Progressive Disclosure）パターン**でドメイン知識を提供する:[^24][^25]

1. **Match** — ユーザープロンプトに対して、どのスキルが適用可能か確認する
2. **Read** — 該当スキルの `SKILL.md` ファイルを読み込む
3. **Execute** — スキルの指示に従って実行する（関連スクリプト・テンプレートも参照）

```python
agent = create_deep_agent(
    skills=["/skills/research/", "/skills/coding/"],
    subagents=[{
        "name": "data-analyzer",
        "skills": ["/skills/data-analysis/"],  # サブエージェント独自のスキル
    }]
)
```

スキルのコンテキストはメインエージェントとサブエージェントで完全に分離されており、スキルの競合が起きない。[^24]

### 4.4 Human-in-the-Loop（人間の承認フロー）

LangGraph の `interrupt()` プリミティブを使い、特定のツール実行前に人間の承認を求めることができる:[^26]

```python
from deepagents import create_deep_agent
from langgraph.checkpoint.memory import InMemorySaver

checkpointer = InMemorySaver()

agent = create_deep_agent(
    tools=[your_tools],
    checkpointer=checkpointer,
    interrupt_on={"write_file": True, "execute": True},  # 承認が必要なツール
)

# 実行が中断されたら Command(resume=...) で再開
from langgraph.types import Command
result = agent.invoke(Command(resume={"approved": True}), config=config)
```

Python と JavaScript の両方で同一の interrupt パターンが利用できる。[^27][^26]

### 4.5 Middleware（ミドルウェア）

`wrap_tool_call` などのデコレータを使って、ツール実行の横断的関心事（ログ、レート制限、バリデーション等）を実装できる:[^16]

```python
from langchain.agents.middleware import wrap_tool_call

@wrap_tool_call
def log_tool_calls(request, handler):
    print(f"[Log] ツール呼び出し: {request.name}")
    result = handler(request)
    print(f"[Log] 完了")
    return result

agent = create_deep_agent(
    tools=[get_weather],
    middleware=[log_tool_calls],
)
```

***

## 5. バージョン履歴と最新動向

### 5.1 リリースタイムライン

| バージョン | リリース日 | 主な変更点 |
|------------|------------|------------|
| 初期リリース | 2025年10月 | LangChain 1.0 / LangGraph 1.0 と同時公開。プランニング、ファイルシステム、サブエージェントの基本機能 |
| v0.2 | 2025年10月28日 | プラグイン可能バックエンド（StateBackend, StoreBackend, FilesystemBackend）、大型ツール出力オフロード、会話要約、中断リカバリー |
| JS版リリース | 2025年11月5日 | `npm install deepagents` で JS/TS にも対応 |
| スキル機能 | 2025年11月24日 | SKILL.md による段階的開示スキル機能を CLI に追加 |
| v0.5 | 2026年4月7日 | 非同期（non-blocking）サブエージェント、マルチモーダルファイルシステム対応（PDF・動画） |

[^23][^3][^4][^25][^14]

### 5.2 v0.5 の詳細

2026年4月7日にリリースされた v0.5 の目玉は **async サブエージェント**だ。従来のインラインサブエージェントは、メインエージェントがサブエージェントの完了を待つ必要があった。v0.5 では:[^4][^18]

- サブエージェントが**リモートサーバー上でバックグラウンド実行**される
- メインエージェントはタスクIDを受け取り、ユーザーとの会話を継続しながら別作業を進められる
- サブエージェントは**ステートフル**で、スレッドをまたいで追加指示（course correction）が可能
- 複数の async サブエージェントを**並列実行**できる

さらに、マルチモーダルファイルシステムのサポートが拡張され、PDF やビデオといったデータ型も取り扱えるようになった。[^19]

### 5.3 Agent Protocol と A2A との関係

Deep Agents は LangChain 独自の **Agent Protocol 仕様**に基づいて構築されており、Google の A2A（Agent-to-Agent）プロトコルや ACP（Agent Client Protocol）とは意図的に分離されている。LangChain がこの判断をした理由として:[^28]

- ACP は現在 stdio トランスポートのみサポートし、ローカルサブプロセスに限定される
- A2A はより充実した機能を持つが、LangChain は async サブエージェントの成熟を待ちながら独自の反復サイクルを優先した

一方、LangSmith の Agent Server 上では A2A エンドポイントがすでに実装されており、MCP（Model Context Protocol）については `langchain-mcp-adapters` パッケージが既存ツールとして提供されている。A2A ネイティブ対応の `langchain-a2a-adapters` パッケージも GitHub で要望が上がっており、今後の対応が注目される。[^29][^30][^31]

***

## 6. ユースケース

Deep Agents は特に**「深い作業（Deep Work）」型のタスク**で威力を発揮する:[^32][^9]

### 6.1 リサーチエージェント

最も典型的なユースケース。Tavily などの検索ツールを組み合わせることで、複数ソースを横断調査し、最終レポートを生成する長時間タスクに対応する:[^33][^5]

- 検索ツール（Tavily, Serper 等）を `tools` に渡す
- リサーチサブエージェントと批評サブエージェントを組み合わせて品質を担保
- 中間結果をファイルシステムに保存しながら進捗を管理

### 6.2 コーディングエージェント

コードリポジトリの読み込み、変更計画、機能追加、テスト実行、ドキュメント作成をエンドツーエンドで実行できる:[^32]

- `execute` ツールでシェルコマンドを実行（テスト、リンター等）
- `read_file` / `write_file` でコードベースを操作
- 長期メモリに学習した知識（コーディング規約等）を保存

### 6.3 ETL・データ処理ワークフロー

大量の中間アーティファクトを生成するパイプライン処理に適している:[^23]

- 巨大なツール出力（DB クエリ結果、ファイル読み込み）を自動でファイルシステムにオフロード
- 複数のデータ処理サブエージェントを並列実行（v0.5 以降）

### 6.4 フロントエンド連携（AG-UI + CopilotKit）

FastAPI バックエンド + Deep Agents + AG-UI プロトコルを組み合わせることで、エージェントの実行ステップをリアルタイムで Next.js などのフロントエンドにストリーミングできる。[^5]

***

## 7. 他フレームワークとの比較

### 7.1 Deep Agents / LangGraph / CrewAI 比較

| 観点 | Deep Agents | LangGraph（生） | CrewAI |
|------|-------------|-----------------|--------|
| 抽象レベル | 高（ハーネス） | 低（グラフ操作） | 高（ロールベース） |
| セットアップ速度 | 速い（5行で動作） | 遅い（60行以上） | 速い（20行） |
| 長期タスク対応 | ◎（コンテキスト管理内蔵） | △（自前実装が必要） | △（限定的） |
| カスタマイズ性 | 高（LangGraph の全機能） | 最高 | 中程度 |
| マルチモーダル | ○（v0.5 以降） | カスタム実装 | ○（2025年追加） |
| プランニング | ◎（write_todos 内蔵） | 自前実装 | ○（タスク定義） |
| 状態管理 | ◎（ファイルシステム抽象化） | ◎（グラフステート） | △ |
| LangSmith 連携 | ◎ | ◎ | △ |

[^34][^35][^36][^37]

### 7.2 Deep Agents vs. 標準の LangChain エージェント

```
標準エージェント（AgentExecutor / ReAct）
  → 短いツール呼び出しループ
  → コンテキスト管理なし
  → 計画機能なし

Deep Agents
  → 長時間・多ステップタスク
  → 自動コンテキスト圧縮
  → write_todos による明示的プランニング
  → サブエージェントへの委譲
  → セッションをまたぐ長期メモリ
```

公式の使い分けガイドラインは「自律的に複雑・非決定的・長時間のタスクを処理させたい場合は Deep Agents を使え」としている。[^38]

***

## 8. 制限と注意点

### 8.1 コンテキスト圧縮の副作用

コンテキスト管理機能は便利だが、要約後のセッションでは**古いメッセージの逐語的な参照ができなくなる**。具体的な影響:[^39]

- 古いツール結果を直接再参照できない
- エラーリカバリー時に過去のデータを再取得・再実行が必要になる場合がある

### 8.2 コスト

複雑な長時間タスクは多くのトークンを消費する。LangChain の Open Deep Research プロジェクトでは、ナイーブな実装で1回あたり50万トークン・$1〜2のコストが発生した事例が報告されている。Deep Agents のコンテキスト管理機能はこれを大幅に削減するが、長期タスクのコスト試算は事前に行うべきだ。[^8]

### 8.3 A2A ネイティブ対応の未完成

他フレームワーク（AutoGen、CrewAI、Google ADK 等）で構築されたエージェントとのネイティブな相互運用には、現状 LangSmith 経由の A2A エンドポイントか、カスタム実装が必要。`langchain-a2a-adapters` パッケージの公式提供はまだない。[^30][^31]

### 8.4 非同期サブエージェントの前提条件（v0.5）

非同期サブエージェントはリモートサーバー上で動作するため、LangSmith Deployments などのデプロイインフラが必要になる場合がある。ローカル開発環境では引き続きインライン（同期）サブエージェントを使うのが現実的だ。[^40]

***

## 9. 実践的なポイントとベストプラクティス

### 9.1 システムプロンプトの重要性

公式ドキュメントは「deep agent の成功においてプロンプトエンジニアリングの重要性は過小評価できない」と明記している。各ユースケースに特化したシステムプロンプトを丁寧に設計することが品質直結の要因だ。[^7]

### 9.2 段階的な構築アプローチ

1. まず `create_deep_agent()` に最小限のツールとシステムプロンプトだけを渡す
2. LangGraph Studio でエージェントの実行過程を可視化しながらデバッグ
3. 必要に応じてサブエージェントを追加し、コンテキスト圧縮の挙動を確認
4. 本番投入時は LangSmith で監視とトレースを設定

### 9.3 モデル選択

- **Anthropic Claude シリーズ**（claude-sonnet-4-6 等）：長いコンテキスト処理が得意で、ファイルシステムとの相性が良い
- **OpenAI GPT-4.1 系**：コーディングタスクで強み
- サブエージェントにはメインエージェントと異なるモデルを指定可能なため、コストとパフォーマンスのバランスを使い分けられる[^16]

### 9.4 JavaScript での利用

JS/TS 開発者は `npm install deepagents` で Python 版と同等の API が利用できる。v0.5 では Python 版と JS 版が同時リリースされており、両エコシステムのパリティが維持されている。[^41][^14]

***

## 10. エコシステムとリソース

### 主要リンク

| リソース | URL |
|----------|-----|
| 公式サイト | https://www.langchain.com/deep-agents |
| Python ドキュメント | https://docs.langchain.com/oss/python/deepagents/overview |
| JavaScript ドキュメント | https://docs.langchain.com/oss/javascript/deepagents/quickstart |
| GitHub (Python) | https://github.com/langchain-ai/deepagents |
| GitHub (async reference) | https://github.com/langchain-ai/async-deep-agents |
| PyPI | https://pypi.org/project/deepagents/ |
| LangChain Blog | https://blog.langchain.com/ |

[^42][^43][^15][^38][^40]

***

## Zenn記事構成のヒント

調査内容をもとに、以下のような記事構成が読者に刺さりやすい:

**パターンA: 「ハンズオン重視型」**
1. Deep Agents とは何か（2分で理解）
2. インストールから最初のエージェントまで（コピペで動くコード）
3. リサーチエージェントを作ってみる（Tavilyとの組み合わせ）
4. サブエージェントでタスクを分担させる
5. 長期メモリを使って「賢くなる」エージェントを作る
6. Human-in-the-Loop で安全なエージェントを実装する

**パターンB: 「概念・アーキテクチャ重視型」**
1. 通常のエージェントが抱える問題（コンテキストウィンドウ問題）
2. Claude Code / Deep Research が解決した方法
3. Deep Agents はその解決策をどうパッケージ化したか
4. LangGraph との関係性（Deep Agents = LangGraph ラッパー）
5. v0.5 の async サブエージェントが意味すること
6. CrewAI / LangGraph との使い分け

**パターンC: 「最新動向フォーカス型」**
1. v0.5 リリース（2026年4月）の何が革新的か
2. async サブエージェントのアーキテクチャ解説
3. A2A / MCP との関係と今後の展望
4. JS/Python の機能パリティ達成の意味

---

## References

1. [LangChain Releases Deep Agents: A Structured Runtime for ...](https://www.marktechpost.com/2026/03/15/langchain-releases-deep-agents-a-structured-runtime-for-planning-memory-and-context-isolation-in-multi-step-ai-agents/) - LangChain Releases Deep Agents: A Structured Runtime for Planning, Memory, and Context Isolation in ...

2. [A Batteries-Included Agent Harness for Complex Tasks - Clauday](https://clauday.com/article/163f76b0-53b2-4956-976e-e08cf6867927) - LangChain has released Deep Agents, a production-ready agent harness built on LangGraph that comes e...

3. [うさぎでもわかる🐰LangChain 1.0 × Deep Agents完全ガイド](https://note.com/taku_sid/n/ne94816bdaefa) - この記事は🐰エージェントが執筆し、飼い主が可能な限りハルシネーションのチェックを行っています はじめに こんにちは、🐰エージェントです！ 2025年10月、LangChainとLangGraphの両方...

4. [Deep Agents v0.5](https://blog.langchain.com/deep-agents-v0-5/) - 💡TL;DR: We’ve released new minor versions of deepagents & deepagentsjs, featuring async (non-blockin...

5. [How to Build a Research Assistant using Deep Agents](https://dev.to/copilotkit/how-to-build-a-research-assistant-using-deep-agents-2bpg) - LangChain's Deep Agents provide a new way to build structured, multi-agent systems that can plan, de...

6. [LangChain releases DeepAgents 0.2 with improved tooling and ...](https://www.linkedin.com/posts/rajyadav-trainer_doubling-down-on-deepagents-activity-7389221728964677632-q-3d) - 🔍 Optimising for autonomy: What’s new with DeepAgents The DeepAgents team at LangChain has released ...

7. [deepagents · PyPI](https://pypi.org/project/deepagents/0.2.4/) - General purpose 'deep agent' with sub-agent spawning, todo list capabilities, and mock file system. ...

8. [LangChain: Context Engineering and Agent Development at Scale ...](https://www.zenml.io/llmops-database/context-engineering-and-agent-development-at-scale-building-open-deep-research) - Lance Martin from LangChain discusses the emerging discipline of "context engineering" through his e...

9. [LangChain's Deep Agents Solve Context Window Bottleneck](https://www.linkedin.com/posts/umesh-bachani-816b0b30_ai-langchain-deepagents-activity-7412821902219673600-K4_w) - The Shift from Simple Loops to Cognitive Architectures in Agentic AI One of the persistent challenge...

10. [LangChain Releases Deep Agents: A Structured Runtime for Planning, Memory, ...](https://www.marktechpost.com/2026/03/15/langchain-releases-deep-agents-a-structured-runtime-for-planning-memory-and-context-isolation-in-multi-step-ai-agents/?amp) - LangChain Releases Deep Agents: A Structured Runtime for Planning, Memory, and Context Isolation in ...

11. [GitHub - langchain-ai/deepagents: Agent harness built with ...](https://www.reddit.com/r/LangChain/comments/1rzcsf4/github_langchainaideepagents_agent_harness_built/) - The agent has full read, write, and search permissions across absolute paths. It also addresses cont...

12. [Context Management for Deep Agents | B Lab](https://b-lab.team/en/content/7f2b31b9-cfb9-45e8-9f1d-2cc069904143) - The Deep Agents SDK tackles LLM context limitations for long-running AI agent tasks by implementing ...

13. [Context Management for Deep Agents - LangChain Blog](https://blog.langchain.com/context-management-for-deepagents/) - By Chester Curme and Mason Daugherty As the addressable task length of AI agents continues to grow, ...

14. ["Deep Agents JS: A Powerful Agent Framework for JS Ecosystem"](https://www.linkedin.com/posts/langchain_deep-agents-js-deep-agents-is-now-available-activity-7392236824448077825-pO0j) - 🤖 Deep Agents JS Deep Agents is now available in JS! Written on top of LangChain and LangGraph 1.0, ...

15. [Quickstart - Docs by LangChain](https://docs.langchain.com/oss/javascript/deepagents/quickstart) - Build your first deep agent in minutes

16. [Customize Deep Agents - Docs by LangChain](https://docs.langchain.com/oss/python/deepagents/customization) - Deep agent tools can make use of virtual file systems to store, access, and edit files. By default, ...

17. [Building Deep Agents with LangChain: A Complete Hands-On Tutorial](https://krishcnaik.substack.com/p/building-deep-agents-with-langchain) - Building deep agents with langchain and langsmith

18. [LangChain Deep Agents v0.5: Async Subagents & Multi ...](https://aitoolly.com/ai-news/article/2026-04-08-langchain-releases-deep-agents-v05-featuring-async-subagents-and-expanded-multi-modal-filesystem-sup) - Explore LangChain's Deep Agents v0.5 release featuring async non-blocking subagents and expanded mul...

19. [LangChain Launches Deep Agents v0.5 with Async Subagents for ...](https://www.mexc.co/news/1010843) - LangChain releases Deep Agents v0.5 featuring async subagents, expanded multimodal support for PDFs ...

20. [Long-term memory - Docs by LangChain](https://7x.mintlify.app/oss/python/deepagents/long-term-memory) - Learn how to extend deep agents with persistent memory across threads

21. [Memory - Docs by LangChain](https://docs.langchain.com/oss/python/deepagents/memory) - Add persistent memory to agents built with Deep Agents so they learn and improve across conversation...

22. [LangChain Expands DeepAgents Capability with New Update](https://blockchain.news/news/langchain-expands-deepagents-capability-with-new-update) - LangChain introduces significant enhancements to DeepAgents with release 0.2, offering pluggable bac...

23. [LangChain doubles down on DeepAgents with v0.2 release](https://howaiworks.ai/blog/langchain-doubling-down-on-deepagents) - LangChain ships DeepAgents v0.2: plugin backends, offloading big tool outputs, conversation summariz...

24. [Skills - Docs by LangChain](https://docs.langchain.com/oss/python/deepagents/skills) - When you create a deep agent, you can pass in a list of directories containing skills. As the agent ...

25. [Using skills with Deep Agents - LangChain Blog](https://blog.langchain.com/using-skills-with-deep-agents/) - tl;dr: Anthropic recently introduced the idea of agent skills. Skills are simply folders containing ...

26. [Human-in-the-loop - Docs by LangChain](https://docs.langchain.com/oss/python/deepagents/human-in-the-loop) - Deep Agents support human-in-the-loop workflows through LangGraph's interrupt capabilities. You can ...

27. [Interrupts within tool calls](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop) - Learn how to configure human approval for sensitive tool operations

28. [LangChain Launches Deep Agents v0.5 with Async Subagents for ...](https://www.mexc.co/en-PH/news/1010843) - LangChain releases Deep Agents v0.5 featuring async subagents, expanded multimodal support for PDFs ...

29. [Native Support for A2A Protocol - LangGraph - LangChain Forum](https://forum.langchain.com/t/native-support-for-a2a-protocol/1302) - hello there! what's the plan from langchain to support a2a protocol natively? Agent2Agent (A2A) Prot...

30. [langchain-a2a-adapters · Issue #35724 - GitHub](https://github.com/langchain-ai/langchain/issues/35724) - I would like LangChain to provide a langchain-a2a-adapters package that wraps remote A2A agents as L...

31. [A2A endpoint in Agent Server - Docs by LangChain](https://docs.langchain.com/langsmith/server-a2a) - LangSmith implements A2A support, allowing your agents to communicate with other A2A-compatible agen...

32. [Deep Agent Use Cases That Work in Production AI Systems](https://10clouds.com/blog/a-i/deep-agent-ai-use-cases-where-deep-agents-actually-deliver-value/) - Explore deep agent use cases that tackle complex AI agentic tasks. See how subagents and Langchain e...

33. [Meet LangChain's DeepAgents Library and a Practical Example to ...](https://www.marktechpost.com/2025/10/20/meet-langchains-deepagents-library-and-a-practical-example-to-see-how-deepagents-actually-work-in-action/) - Discover the potential of LangChain's DeepAgents Library with practical examples illustrating how De...

34. [LangChain - Blogs - Info Services](https://www.infoservices.com/blogs/artificial-intelligence/langchain-multi-agent-ai-framework-2025) - Discover how LangChain powers advanced multi-agent AI systems in 2025 with orchestration tools, plan...

35. [LangGraph vs CrewAI...](https://www.zenml.io/blog/langgraph-vs-crewai) - In this LangGraph vs CrewAI article, we explain the difference between the three platforms and educa...

36. [CrewAI vs LangGraph vs n8n | AI Agent Framework Comparison](https://www.3pillarglobal.com/insights/blog/comparison-crewai-langgraph-n8n/) - Choosing the right AI agent framework is a crucial decision, as it will directly impact your team's ...

37. [Crewai vs. LangGraph: Multi agent framework comparison - Zams](https://www.zams.com/blog/crewai-vs-langgraph) - Objective feature comparison to help you decide — based on features, benefits, and ideal use cases.

38. [LangChain Deep Agents: Build Agents for Complex, Multi-Step Tasks](https://www.langchain.com/deep-agents) - Deep Agents is an open source agent harness built for long-running tasks. It handles planning, conte...

39. [Context Window Management | langchain-ai/deepagents | DeepWiki](https://deepwiki.com/langchain-ai/deepagents/3.5-context-window-management) - This document explains how DeepAgents manages context window limits to prevent token overflow during...

40. [langchain-ai/async-deep-agents](https://github.com/langchain-ai/async-deep-agents) - Async Subagents: Reference Architecture. A reference implementation for non-blocking, background age...

41. [Building a Typescript deep research agent](https://www.youtube.com/watch?v=mUNeBCtJKk0) - In this video, we will walk through how to easily build a Typescript deep research agent

This build...

42. [Deep Agents overview - Docs by LangChain](https://docs.langchain.com/oss/python/deepagents/overview) - The easiest way to start building agents and applications powered by LLMs—with built-in capabilities...

43. [langchain-ai/langchain: The agent engineering platform](https://github.com/langchain-ai/langchain) - Build agents that can plan, use subagents, and leverage file systems for complex tasks · LangGraph —...

