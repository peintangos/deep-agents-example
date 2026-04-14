# spec-006: HITL 承認フロー統合

## Overview

LangGraph の `interrupt()` プリミティブと Deep Agents の `interrupt_on` オプションを使って、特定のツール実行前に人間の承認を挟む。対象ツールは以下:

- **外部 API 呼び出し**: GitHub API / OSV API — 大量呼び出しでレート制限を食わないように初回だけ承認
- **最終レポート書き込み**: `out/` 配下への最終レポート生成前に内容を人間が確認
- **長期メモリ更新**: `/memories/` 配下への書き込み前（ポリシー書き換え事故防止）

HITL は "必然性がないと演出的に見える" 機能なので、Zenn 記事ではこの必然性を軸に書く。

## Acceptance Criteria

```gherkin
Feature: 特定ツールの実行前に人間の承認を挟む

  Background:
    checkpointer 付きで deep agent が起動している

  Scenario: 最終レポート書き込み前に中断する
    Given エージェントが最終レポート生成に到達する
    When `write_report` ツールを呼ぼうとする
    Then 実行が中断され、ユーザーに承認を要求する

  Scenario: 承認後に再開する
    Given HITL で中断している状態
    When ユーザーが `Command(resume={approved: true})` で再開する
    Then ツール呼び出しが実行され、残りのフローが続く

  Scenario: 却下後に代替経路を取る
    Given HITL で中断している状態
    When ユーザーが却下の選択をする
    Then エージェントは該当ツールをスキップし、理由をログに残す
```

## Implementation Steps

- [x] `createDeepAgent()` に `checkpointer` (`MemorySaver` — TS では `InMemorySaver` ではなく `MemorySaver` が正しい名称) と `interruptOn` を追加 (`src/agent.ts` の `CreateAuditAgentOptions` に両方を optional 注入できる DI パターンを確立、デフォルトで `fetch_github` + `query_osv` に承認を要求、`write_file` は `/raw/` への書き込みと衝突するため除外)
- [x] CLI 側で中断を検出してプロンプトを出し、ユーザー入力を `Command(resume=...)` に変換するハンドラを実装 (`src/hitl.ts` に pure core、`scripts/run-audit.ts` に readline ベースの consolePolicy + HITL ループを実装。`MAX_HITL_ITERATIONS = 20` で無限ループを防止、`thread_id` は `randomUUID()` で毎回新規に発行)
- [x] 承認 / 却下のログを `/raw/hitl/log.jsonl` に残す (`src/hitl-log.ts` で JSONL 形式の append-only ログを実装。agent の仮想 FS ではなく物理ファイル `out/raw/hitl/log.jsonl` に書く — HITL は CLI 層イベントで agent 内部では発火しないため。壊れた行はスキップする寛容パーサでクラッシュ recovery に対応)
- [ ] テスト: interrupt → resume の E2E 流れ
- [ ] Review (typecheck + test + `/code-review`)
