# Progress — Mastra 監査エージェント MVP

Use only these status values: `pending`, `in-progress`, `done`

## Specification Status

| Specification | Title | Status | Completed On | Notes |
|---------------|-------|--------|--------------|-------|
| spec-001-foundation-setup | 基盤セットアップと deepagents smoke test | done | 2026-04-12 | deepagents v1.9.0 の成熟度問題なし。CLI entry も分離した pure 関数 + 薄い entry 構成で実装 |
| spec-002-shared-tools-and-fs | 共通ツール基盤と仮想 FS レイアウト | done | 2026-04-12 | fs-layout + GitHub/OSV クライアント + LangChain Tool 完了。read_raw/write_raw は built-in ファイルツール + path builders に委譲する設計 |
| spec-003-audit-subagents | 監査サブエージェント実装 (5 観点) | done | 2026-04-12 | 5 サブエージェント factory + 25 tests + agent.ts 登録完了。実 API での task 委譲検証は spec-004 で critic/レポート統合と合わせて行う |
| spec-004-critic-and-report | critic サブエージェントとレポート統合 | done | 2026-04-14 | critic (7 tests) + reporter (10 tests) + AUDIT_SYSTEM_PROMPT 2 フェーズ化 (5 tests) + writeAuditReport ラッパ + モック raw → tmpdir E2E (4 tests)。LLM 呼び出しを伴う本物の E2E は spec-009 で別途実施 |
| spec-005-long-term-memory | 長期メモリ統合 | in-progress | | `createDeepAgent({ store, backend: CompositeBackend })` で `/memories/` → StoreBackend を配線完了 (4 tests)。`use_longterm_memory: true` は v1.9 非存在だったため CompositeBackend 構成に読み替え。残りは memory/policy.ts / user-preferences / history / 統合テスト |
| spec-006-human-in-the-loop | HITL 承認フロー統合 | pending | | |
| spec-007-skills-integration | Skills 統合 | pending | | |
| spec-008-middleware | Middleware 統合 | pending | | |
| spec-009-e2e-mastra-audit | Mastra を対象にした E2E 実行と最終レポート生成 | pending | | |

## Summary

- Done: 4/9
- Current focus: spec-005-long-term-memory
