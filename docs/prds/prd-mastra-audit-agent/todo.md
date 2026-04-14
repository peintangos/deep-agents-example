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
- [x] spec-007: `skills/audit/{license,security,maintenance,api-stability,community}/SKILL.md` を作成し、各観点のチェックリスト・判断基準・NG 例を記述する — 5 ファイルとも YAML frontmatter (name / description / allowed-tools) + 本体 (判定基準テーブル + NG 例 + 出力契約) で統一し、`tests/skills-audit.test.ts` で 26 ケースの形式契約を固定
- [x] spec-007: `skills/report/zenn-style/SKILL.md` を作成し、レポート文体 (だ/である調 + 比較表 + 見出し構造) のガイドラインを定義する — 既存 audit skill と同じ frontmatter 契約 (name/description/allowed-tools) + 本体 (三原則 / 見出し構造 / 比較表必須ケース / critic findings 書き換え / NG 例 / 出力契約) で作成。`tests/skills-report.test.ts` で形式契約 5 + 内容契約 3 を固定 (9 ケース)
- [x] spec-007: `createAuditAgent()` の `skills` オプションに skills ディレクトリを登録し、StateBackend の下でどのように skill ファイルを供給するか (FilesystemBackend ルーティング or 初期 state への注入) を決定・実装する — **決定: CompositeBackend 経由で `/skills/` を `FilesystemBackend({ virtualMode: true })` にルーティング**。`/memories/` → StoreBackend と同じ prefix ルーティングパターンに揃えた。`DEFAULT_SKILLS_ROOT_DIR` は `import.meta.url` ベースでリポジトリ直下の `skills/` に固定解決 (cwd 非依存)。`skillsRootDir` / `skills` を `CreateAuditAgentOptions` に追加し、tests は `tmpdir` で制御された skill セットを流せる。配線証跡 11 テスト (smoke.test.ts の spec-007 describe)
- [x] spec-007: license-analyzer / security-auditor / その他サブエージェントに対応する skill パスを個別割り当てし、全体 skill のうち必要分だけが流れる配線を作る — 6 factory (license/security/maintenance/api-stability/community/critic) に `skills?: readonly string[]` と `DEFAULT_<SUBAGENT>_SKILLS` 定数を追加。粒度 3 階層: 5 obs agents は各自 1 ソース (`/skills/audit/<aspect>/`)、critic はクロス観点の `/skills/audit/` 全体、メインは audit + report。6 ファクトリ × 2 assertions = 12 テスト追加 (合計 259 tests)
- [x] spec-007: skills の段階的開示 (関連する SKILL だけがコンテキストに乗る) を決定論的に検証する最小テストを書く — `tests/skills-progressive-disclosure.test.ts` で minimal createAgent + fakeModel + createSkillsMiddleware を組み、10 ケース (scoping 4 + system prompt 注入 3 + frontmatter shape 3) を固定。実装中に `listSkillsFromBackend` が 1 階層走査制限を持つことが判明し、f2e0660 で誤って設定していた 5 観測 subagent の `DEFAULT_<SUBAGENT>_SKILLS` (`/skills/audit/<aspect>/` 形式、0 skill しか返らなかった) を `/skills/audit/` に修正。回帰ガードとして `sources=['/skills/audit/license/'] → 0 skills` を固定
- [x] spec-008: `src/middleware/logging.ts` でツール呼び出しロギング middleware を実装する (pure event builder + sink DI + langchain `createMiddleware` の `wrapToolCall` フック) — 4 層構成 (pure event / JSONL format / file sink / middleware) で実装。sink 注入でテストは in-memory array に差し替え可能。失敗時は sink 記録後に `throw` を rethrow し、エージェント側に成功を偽装しない。`tests/middleware/logging.test.ts` に 13 ケース (pure 4 + format 2 + file I/O 3 + E2E 4)、合計 282 tests
- [x] spec-008: `src/middleware/rate-limit.ts` で GitHub API レート制限対応 middleware を実装する (閾値ベースで最小待機時間を挿入) — response header に依存しない **min-interval 方式** を採用。`DEFAULT_GITHUB_MIN_INTERVAL_MS=700` (5000 req/hour 上限に対して ~1.43 req/sec 以下で安全寄り)、`fetch_github` をデフォルト対象。pure `computeSleepMs` + middleware factory (`now` / `sleep` の DI) の 2 層で clock-skew cap まで含めて 11 テスト
- [x] spec-008: `src/middleware/validate.ts` でツール引数バリデーション middleware を実装する (不正なリポジトリ URL 等を handler 呼び出し前に弾く) — zod schema で通る "意味的に不正" な引数 (owner 空白・trailing hyphen・repo 先頭ドット・path traversal 等) を正規表現 + 個別チェックで弾く。rejection は **throw ではなく `ToolMessage`** を返して LLM に補正を促す (langchain の tool rejection パターン)。`validators` map を DI にして `DEFAULT_TOOL_VALIDATORS = { fetch_github: validateGithubRepoArgs }` を既定とした。19 tests (pure 13 + middleware 4 + exports 2)
- [x] spec-008: `createAuditAgent()` の `middleware` オプションに 3 つの middleware を配線し、wrap 順序を統合テストで確認する (`middleware?` を `CreateAuditAgentOptions` に DI で追加) — `createDefaultAuditMiddlewares({ toolCallLogSink?, toolCallLogPath?, rateLimit? })` ヘルパを export し、default で `[logging, validate, rate-limit]` の 3 本を返す。`DEFAULT_TOOL_CALL_LOG_PATH = "out/.state/tool-calls.jsonl"` を spec-008 の acceptance criterion に合わせて固定。`tests/middleware/integration.test.ts` に wrap 順序 2 + DI 4 + factory 1 = 7 tests。invalid args で sleep spy が呼ばれない点が順序検証の決定打 (319 tests 全通過)
