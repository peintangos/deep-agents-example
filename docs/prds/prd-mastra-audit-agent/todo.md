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
