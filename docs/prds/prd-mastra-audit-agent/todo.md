# TODO — Mastra 監査エージェント MVP

<!--
Keep tasks in priority order.
Each unchecked task should be small enough to complete in one `/implement` run or one Ralph iteration.
Mark completed tasks with `- [x]` instead of removing them.
-->

- [x] spec-001: TypeScript プロジェクト雛形（tsconfig.json / src / tests / npm scripts）を作成する
- [x] spec-001: `deepagents` (JS 版) を依存追加し、最小構成のエージェントを起動できることを確認する smoke test を書く
- [x] spec-001: `scripts/run-audit.ts` の CLI エントリポイントを用意し、`npx tsx scripts/run-audit.ts --help` が動くところまで実装する
- [x] spec-002: 仮想ファイルシステムのディレクトリ設計 (`/raw/`, `/reports/`, `/memories/`) を決定し、ヘルパーを実装する
- [x] spec-002: GitHub API / OSV API クライアントを薄くラップし、各サブエージェントから再利用できるようにする
- [x] spec-002: 共通ツール (`fetch_github`, `query_osv`) をエージェント向けの LangChain Tool として実装する (`read_raw`/`write_raw` は deepagents built-in + path builders に委譲)
- [x] spec-003: `src/subagents/license-analyzer.ts` を実装し、サブエージェント factory パターンをリファレンスとして確立する (`fetch_github` ツール付与、`/raw/license/result.json` への出力指示)
- [x] spec-003: `security-auditor` / `maintenance-health` / `api-stability` / `community-adoption` の 4 サブエージェントを license-analyzer のパターンで量産する
- [x] spec-003: `src/agent.ts` で 5 サブエージェントを `subagents` に登録する (実 API 呼び出しでの `task` 委譲検証は spec-004 で critic/レポート統合と合わせて行う)
- [x] spec-004: `src/subagents/critic.ts` を追加し、整合性検証向けに system_prompt を設計する (5 観点の raw を読み `/raw/critic/findings.json` に書き出す)
- [x] spec-004: `src/reporter.ts` で 5 観点の raw + critic findings を読み込み、`out/mastra-audit-report.md` を生成する pure 関数を実装する
- [x] spec-004: `src/agent.ts` のメインエージェント system_prompt を "監査 → critic → reporter" のオーケストレーション順序で更新し、critic サブエージェントを `subagents` に登録する
- [x] spec-004: `.gitignore` に `out/` を追加し、生成物をリポジトリ管理外にする (Ralph Matsuo テンプレート初期化時点で既に `out/` が含まれていたことを確認)
- [x] spec-004: モック raw データを使った最小 E2E テスト (reporter が 5 観点セクションと findings セクションを含む Markdown を生成する) を書く
- [x] spec-005: `createDeepAgent()` に `store` と `backend`(`/memories/` → `StoreBackend`) を配線し、`createAuditAgent({ store })` で注入可能にする (v1.9 の API に合わせて spec の `use_longterm_memory: true` はドロップ)
- [x] spec-005: `src/memory/policy.ts` で監査ポリシー (`/memories/audit-policy.json`) の読み書きヘルパーを実装する
- [x] spec-005: ユーザー好み (レポート文体 / 優先観点) を `/memories/user-preferences.json` に記録 / 復元するヘルパーを実装する
- [x] spec-005: 過去の監査履歴を `/memories/history/<target>-<yyyy-mm>.json` に保存するヘルパーと AUDIT_SYSTEM_PROMPT への履歴参照指示を追加する
- [x] spec-005: 同一 store を共有した 2 回の createAuditAgent 呼び出しで `/memories/` のデータが維持されることを検証する統合テストを書く
- [x] spec-006: `createAuditAgent()` に `checkpointer` (MemorySaver) と `interruptOn` を追加し、外部 API 系ツール (`fetch_github`, `query_osv`) を承認対象に含める (`write_file` は built-in 経由で `/raw/` にも呼ばれるので除外し、`/memories/` / `/reports/` への書き込みは orchestrator 側で HITL する方針に変更)
- [x] spec-006: CLI (`src/cli.ts`) に interrupt 検出 → 承認プロンプト → `Command(resume=...)` ハンドラを pure 関数として追加する (interactive I/O は `scripts/run-audit.ts` 側に薄く置く) — `src/hitl.ts` に pure core (`detectHitlInterrupt` / `resolveHitlInterrupt` / `formatActionForHuman` / `APPROVE_ALL_POLICY` / `REJECT_ALL_POLICY`) を新設し、対話 I/O と HITL ループは `scripts/run-audit.ts` 側に配置した
- [x] spec-006: 承認 / 却下イベントを `/raw/hitl/log.jsonl` に追記する HITL ログヘルパーを実装する — `src/hitl-log.ts` に pure 関数 (`createHitlLogEvent` / `formatHitlEventLine`) と I/O 関数 (`appendHitlEvents` / `readHitlEvents`) を実装し、`scripts/run-audit.ts` の HITL ループから各 decision を `out/raw/hitl/log.jsonl` に追記
- [x] spec-006: interrupt → resume → 完了 の 1 サイクルを検証する E2E テストを書く (LLM 呼び出しは差し替え可能にし、interrupt の発火と resume の反映だけを決定論的に追う) — `tests/hitl-e2e.test.ts` で langchain の `createAgent` + `humanInTheLoopMiddleware` + factory-based `fakeModel` を使い、interrupt 検出 / approve / reject / 2 thread 並行の 4 ケースを決定論的に検証
