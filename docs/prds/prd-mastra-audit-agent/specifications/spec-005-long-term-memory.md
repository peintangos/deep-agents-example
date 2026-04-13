# spec-005: 長期メモリ統合

## Overview

Deep Agents の長期メモリ機能 (`/memories/` プレフィックス) を使って、セッションをまたいで保持すべき情報を永続化する。対象は以下:

- **監査ポリシー**: 観点ごとの重み付け、除外したいチェック項目
- **ユーザー好み**: レポート文体（だ/である調 vs ですます調）、優先する監査観点
- **過去の監査履歴**: 同じ OSS を再監査する際の差分取得用

`LangGraph Store` (InMemoryStore から開始し、必要なら SQLite に切替可能) を使う。

**v1.9 API への適応**: 当初 spec では Python 版 deepagents の `use_longterm_memory: true` フラグを想定していたが、deepagents TS v1.9 には同等のフラグは存在しない。代わりに以下の配線で同等機能を実現する:

1. `createDeepAgent({ store: BaseStore })` で store を注入
2. `backend` オプションに `new CompositeBackend(new StateBackend(config), { "/memories/": new StoreBackend() })` を渡し、パスプレフィックスベースのルーティングで `/memories/` 配下を永続化

これで `write_file("/memories/x.json", ...)` のような既存の built-in ツール呼び出しがそのまま長期メモリに振り分けられる。

## Acceptance Criteria

```gherkin
Feature: 長期メモリがセッションをまたいで保持される

  Background:
    Deep Agents に LangGraph Store が設定されている

  Scenario: 監査ポリシーがセッションをまたいで復元される
    Given 前回の監査実行で `/memories/audit-policy.json` が書かれた
    When 次回の監査実行でエージェントが起動する
    Then 同じポリシーがメモリから読み込まれる

  Scenario: 通常パスに書いたファイルはセッション終了で消える
    Given 通常パス `/scratch/temp.txt` に書き込む
    When セッションを終了して再起動する
    Then `/scratch/temp.txt` は存在しない

  Scenario: 過去の監査結果と比較できる
    Given `/memories/history/mastra-2026-04.json` に前回の結果が保存されている
    When 今回の監査を実行する
    Then エージェントが前回との差分を認識できる
```

## Implementation Steps

- [x] `createDeepAgent()` の呼び出しに `store` と `backend` (CompositeBackend で `/memories/` → StoreBackend にルーティング) を追加 — v1.9 API に合わせて `use_longterm_memory: true` からは読み替え
- [x] `src/memory/policy.ts` で監査ポリシーの読み書きヘルパーを実装 (`store-helpers.ts` で BaseStore 直結の `readMemoryJson` / `writeMemoryJson` を共通化し、`policy.ts` は `AuditPolicy` 型と薄いラッパに留めた)
- [x] ユーザー好みの記録フロー (`src/memory/preferences.ts`: `tone` (formal/polite) と `priorityAspects` の正規化付き read/write。**初回対話収集の HITL 統合は spec-006 に委譲**。本 spec の範囲は永続化レイヤのみ)
- [x] 過去の監査履歴を `/memories/history/` 配下に JSON で保存 (`src/memory/history.ts`: `auditHistoryMemoryPath`, `slugifyAuditTarget`, `extractYearMonth`, `read/writeAuditHistoryEntry`。`AUDIT_SYSTEM_PROMPT` に Phase 0 として履歴参照指示を追加。**書き込みは agent ではなく orchestrator の責務**として明示)
- [x] テスト: セッション再起動前後でメモリが保持されることを確認 (`tests/memory/cross-session.integration.test.ts`: 同一 BaseStore を共有した 2 回の `createAuditAgent` で 3 種類のメモリが復元される + `CompositeBackend(/memories/ → StoreBackend)` 経由の round-trip も legacy mode で実走させて配線証跡を残した)
- [x] Review (typecheck + test + `/code-review` + advisor reconcile)
