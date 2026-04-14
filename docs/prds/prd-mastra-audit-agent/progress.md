# Progress — Mastra 監査エージェント MVP

Use only these status values: `pending`, `in-progress`, `done`

## Specification Status

| Specification | Title | Status | Completed On | Notes |
|---------------|-------|--------|--------------|-------|
| spec-001-foundation-setup | 基盤セットアップと deepagents smoke test | done | 2026-04-12 | deepagents v1.9.0 の成熟度問題なし。CLI entry も分離した pure 関数 + 薄い entry 構成で実装 |
| spec-002-shared-tools-and-fs | 共通ツール基盤と仮想 FS レイアウト | done | 2026-04-12 | fs-layout + GitHub/OSV クライアント + LangChain Tool 完了。read_raw/write_raw は built-in ファイルツール + path builders に委譲する設計 |
| spec-003-audit-subagents | 監査サブエージェント実装 (5 観点) | done | 2026-04-12 | 5 サブエージェント factory + 25 tests + agent.ts 登録完了。実 API での task 委譲検証は spec-004 で critic/レポート統合と合わせて行う |
| spec-004-critic-and-report | critic サブエージェントとレポート統合 | done | 2026-04-14 | critic (7 tests) + reporter (10 tests) + AUDIT_SYSTEM_PROMPT 2 フェーズ化 (5 tests) + writeAuditReport ラッパ + モック raw → tmpdir E2E (4 tests)。LLM 呼び出しを伴う本物の E2E は spec-009 で別途実施 |
| spec-005-long-term-memory | 長期メモリ統合 | done | 2026-04-14 | store + CompositeBackend 配線 (4 tests) + `src/memory/{policy,preferences,history,store-helpers}.ts` (47 tests) + `AUDIT_SYSTEM_PROMPT` Phase 0 履歴参照指示 + 同一 store 共有 cross-session 統合テスト (6 tests, うち 1 つは `CompositeBackend` legacy mode 経由の配線証跡)。`use_longterm_memory: true` は v1.9 非存在のため CompositeBackend 構成に読み替え。HITL での初回 preferences 収集は spec-006、実 LLM での E2E は spec-009 に委譲 |
| spec-006-human-in-the-loop | HITL 承認フロー統合 | in-progress | | `createAuditAgent()` に `checkpointer` (MemorySaver) と `interruptOn` を DI で注入可能にし、`fetch_github` + `query_osv` を承認対象に配線 (smoke tests 6 本追加)。`src/hitl.ts` に pure core (detect / resolve / format / 2 presets、23 tests)、`scripts/run-audit.ts` に readline ベース consolePolicy + HITL ループを実装。`src/hitl-log.ts` に JSONL ログヘルパー (16 tests) を追加し HITL ループから `out/raw/hitl/log.jsonl` に追記。残タスクは interrupt→resume E2E |
| spec-007-skills-integration | Skills 統合 | pending | | |
| spec-008-middleware | Middleware 統合 | pending | | |
| spec-009-e2e-mastra-audit | Mastra を対象にした E2E 実行と最終レポート生成 | pending | | |

## Summary

- Done: 5/9
- Current focus: spec-006-human-in-the-loop (次)
