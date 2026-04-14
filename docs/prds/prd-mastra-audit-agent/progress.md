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
| spec-006-human-in-the-loop | HITL 承認フロー統合 | done | 2026-04-14 | `createAuditAgent()` に `checkpointer` (MemorySaver) と `interruptOn` を DI で注入可能にし、`fetch_github` + `query_osv` を承認対象に配線 (smoke tests 6 本追加)。`src/hitl.ts` に pure core (detect / resolve / format / 2 presets、23 tests)、`scripts/run-audit.ts` に readline ベース consolePolicy + HITL ループを実装。`src/hitl-log.ts` に JSONL ログヘルパー (16 tests)。`tests/hitl-e2e.test.ts` で factory-based `fakeModel` を使った interrupt→approve→complete / reject→complete / 2 thread 並行の 4 ケース E2E |
| spec-007-skills-integration | Skills 統合 | done | 2026-04-14 | audit 5 SKILL.md (26 tests) + report/zenn-style SKILL.md (9 tests) + `createAuditAgent` 3-way CompositeBackend ルーティング配線 + `skillsRootDir`/`skills` DI (smoke 11 tests) + 6 subagent factory への `skills` DI + 段階的開示テスト `tests/skills-progressive-disclosure.test.ts` (10 tests)。段階的開示テスト実装時に `listSkillsFromBackend` の 1 階層走査制限を発見し、5 観測 subagent の default を `/skills/audit/<aspect>/` → `/skills/audit/` に修正 (粒度は 2 階層: 観測/critic = audit / main = audit+report)。合計 269 tests 全通過 |
| spec-008-middleware | Middleware 統合 | done | 2026-04-14 | `src/middleware/logging.ts` (13) + `rate-limit.ts` (11, min-interval 方式 + `now`/`sleep` DI) + `validate.ts` (19, zod の上に GitHub 命名規則を regex 重ね) + `createAuditAgent` への配線と順序検証 (`createDefaultAuditMiddlewares` で `[logging, validate, rate-limit]` を返し、`DEFAULT_TOOL_CALL_LOG_PATH="out/.state/tool-calls.jsonl"`、tests/middleware/integration.test.ts で wrap 順序 2 + DI 4 + factory 1 = 7 tests)。合計 50 tests for spec-008、319 tests 全通過 |
| spec-009-e2e-mastra-audit | Mastra を対象にした E2E 実行と最終レポート生成 | in-progress | | `--target` オプション + reporter 配線まで完了 (step 1+α/5)。`src/cli.ts` に `AuditRunner` 型を導入して `--invoke` と経路分離、`src/reporter.ts` に pure `extractAuditRawFromState` / `AUDIT_RAW_PATHS` を追加 (FileData v1/v2/Uint8Array 対応、11 新規 tests)、`scripts/run-audit.ts` は `invokeWithHitlLoop` 共通ヘルパ + `realAuditRunner` で invoke→HITL→state 抽出→`writeAuditReport` のオーケストレーションを配線。合計 344 tests 全通過。残りは (2) Mastra 実 E2E (API 消費) / (3) 目視レビュー / (4) tool-calls.jsonl 統計抽出 / (5) 最終 review |

## Summary

- Done: 8/9
- Current focus: spec-009-e2e-mastra-audit (CLI + reporter 配線まで完了、次は実 E2E 実行)
