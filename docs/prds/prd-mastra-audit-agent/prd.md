# Product Requirements Document (PRD) - Mastra 監査エージェント MVP

## Branch

`main`

## Overview

LangChain Deep Agents (TypeScript) を使って、OSS プロジェクト [Mastra](https://github.com/mastra-ai/mastra) を多観点で監査するエージェントを実装する。監査観点ごとにサブエージェントを分担させ、最終的に統合レポート（Markdown）を生成する。実装プロセスと成果物は Zenn 記事の題材として利用する。

## Background

Deep Agents は LangGraph 上に構築された「エージェントハーネス」で、プランニング・サブエージェント・仮想ファイルシステム・長期メモリ・HITL・Skills・Middleware といった主要機能を備える。これらを必然性を持って使い切るデモを作ることで:

1. Deep Agents の実践的な使い方を体系的に理解する
2. OSS 採用前の監査という実用タスクに対する一つの解を提示する
3. Zenn 読者に対して "動くコード + 具体的な成果物 + メタな構造（ライバル OSS を監査する）" を提供する

監査対象に Mastra を選ぶ理由は、Deep Agents の直接的ライバルとなる TypeScript 製 AI エージェントフレームワークであり、ライセンス・依存関係・メンテナンス履歴・API 安定性に "発見" が出やすく記事の引きが強いため。

## Product Principles

- **必然性のある機能利用**: Deep Agents の機能を "使うために" 使うのではなく、タスクの要請から自然に組み込む
- **Docs-first**: 計画はドキュメントを更新し、実装はドキュメントから読む（Ralph Matsuo ワークフロー準拠）
- **再現性**: 読者が同じ手順で手元で動かせることを重視する
- **客観性**: 監査レポートはファクトチェックされた一次情報に基づき、主観的な "評価" は明示的にラベル付けする

## Scope

### In Scope

- Deep Agents (TypeScript) を使った Mastra 監査エージェントの CLI 実装
- 監査観点ごとのサブエージェント: license / security / maintenance / api-stability / community / critic
- プランニング (`write_todos`)、仮想ファイルシステムを使った中間アーティファクト管理
- 長期メモリ（監査ポリシー・ユーザー好み）
- HITL（最終レポート書き込み前・外部 API 呼び出し前の承認）
- Skills（監査観点 / レポート文体）
- Middleware（ツール呼び出しロギング / レート制限）
- 最終レポートの Markdown 生成
- 監査実行の記録（どのサブエージェントがどの raw データを生成したかトレース可能に）

### Out of Scope

- Web UI やダッシュボード（CLI 主体）
- CI/CD への組み込み（手動実行で完結）
- Mastra 以外の OSS への横展開（roadmap の Future Ideas 送り）
- 監査結果を根拠にした "Mastra vs Deep Agents" の主観的な比較記事（別 PRD で扱う）
- async サブエージェント（v0.5 機能）のフル活用（インライン同期で MVP を優先）

## Target Users

- **一次ユーザー**: 本リポジトリのオーナー（Zenn 記事執筆者）
- **想定読者**: TypeScript で AI エージェントを組む開発者、OSS 採用前の技術調査をしたい開発者、Deep Agents / Mastra に興味のある LangChain 利用者

## Use Cases

1. オーナーが CLI から `npm run audit` 的なコマンドを叩き、Mastra リポジトリを対象に全観点の監査をワンショットで実行する
2. オーナーが監査観点ごとにサブエージェントを個別に呼び出し、raw データを確認しながら段階的に実行する
3. 監査途中の外部 API 呼び出しや最終レポート書き込みに対して、HITL で人間の承認を挟む
4. 過去の監査実行履歴を長期メモリに保持し、再実行時に差分だけを追う

## Functional Requirements

- **FR-1**: `createDeepAgent()` を使って、メインエージェントと 6 つのサブエージェント（license / security / maintenance / api-stability / community / critic）を構成できる
- **FR-2**: 各サブエージェントは独立した `system_prompt` と最小限のツールセットを持ち、raw データを仮想ファイルシステムに書き出す
- **FR-3**: メインエージェントは `write_todos` を使って監査フェーズを分解し、進捗を追跡する
- **FR-4**: 外部 API 呼び出し（GitHub API / OSV API など）とレポート書き込みツールは HITL 対象として `interrupt_on` で設定される
- **FR-5**: 監査ポリシーとユーザー好み（レポート文体、優先する観点）は長期メモリ (`/memories/` プレフィックス) に保存され、次回実行時に復元される
- **FR-6**: Skills ディレクトリ配下に `audit-license` `audit-security` `report-style` 等の SKILL.md を配置し、エージェントが段階的開示パターンで読み込む
- **FR-7**: Middleware でツール呼び出しをログに残し、GitHub API のレート制限に引っかからないよう最小限の間引きを行う
- **FR-8**: 最終成果物として `out/mastra-audit-report.md` を生成する。監査観点ごとのセクションと、Critic サブエージェントによるファクトチェック結果を含む
- **FR-9**: 監査実行時に各サブエージェントが生成した raw データ (`/raw/license/*.json` など) を保持し、後から参照できる
- **FR-10**: CLI エントリーポイントを `scripts/run-audit.ts` として用意し、`npx tsx scripts/run-audit.ts` で実行できる

## UX Requirements

- CLI 実行時、Deep Agents のストリーミング出力をそのままターミナルに流す（LangGraph の標準機能）
- HITL 中断時は、どのツール呼び出しが中断しているかと、承認/却下の選択肢を分かりやすく表示する
- 最終レポートは `out/` 配下に Markdown で出力し、読みやすい Zenn 向け構成にする
- 監査中の中間アーティファクトは `out/.state/` 配下に隔離し、git 管理外にする

## System Requirements

- Node.js 20.x 以上 / TypeScript 5.x 以上
- `deepagents` (JS 版) v0.5 以降 — ただし async サブエージェントは MVP では使わない
- LangGraph.js (deepagents が内部で利用)
- `@langchain/anthropic` を使った Claude Sonnet 4.6 呼び出し
- 環境変数 `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`（GitHub API のレート制限緩和）
- 既知のハマりどころ: TS2589 "Type instantiation is excessively deep" — サブエージェントのモデル工場関数で発生する場合は `as unknown as BaseChatModel` で明示キャストする
- 既知のリスク: `deepagents` JS 版の成熟度 — 最初のスペックで最小動作確認 (smoke test) を必ず行う

## Milestones

| Milestone | Description | Target Date |
|-----------|-------------|-------------|
| M1: 基盤セットアップ | TypeScript プロジェクト雛形、deepagents 最小動作確認、環境変数整備 | TBD |
| M2: サブエージェント実装 | 6 つのサブエージェント (license / security / maintenance / api-stability / community / critic) を順次実装 | TBD |
| M3: Deep Agents 主要機能の組み込み | 長期メモリ / HITL / Skills / Middleware を必然性のある形で統合 | TBD |
| M4: 統合と最終レポート生成 | Mastra を対象に E2E で監査を回し、`out/mastra-audit-report.md` を生成 | TBD |
| M5: Zenn 記事執筆 | 実装プロセスと知見を記事化（記事本体は別リポジトリで管理） | TBD |
