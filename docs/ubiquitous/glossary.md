# Glossary

| Term | Definition | Context | Aliases |
|------|-----------|---------|---------|
| PRD | Product Requirements Document. Defines the delivery scope for a feature or project | Planning phase, `docs/prds/` | — |
| Ralph Loop | Autonomous headless execution workflow that processes one todo task per iteration | `scripts/ralph/`, GitHub Actions | — |
| Specification | A Gherkin-oriented feature spec with acceptance criteria and implementation steps | `docs/prds/prd-{slug}/specifications/` | spec |
| Knowledge | Reusable patterns, integration notes, and non-obvious lessons discovered during work | `docs/prds/prd-{slug}/knowledge.md` | — |
| Command Registry | The canonical mapping of role names to repository-specific commands | `ralph.toml` | — |
| Docs-first | The core principle: planning updates documents, execution reads documents | Project-wide | — |
| Deep Agents | LangGraph 上に構築された「エージェントハーネス」。プランニング・サブエージェント・仮想ファイルシステム・長期メモリ・HITL・Skills・Middleware を内包する | `src/`, `docs/references/deep-agents/` | deepagents, deepagentsjs |
| サブエージェント | メインエージェントが `task` ツールで生成する、コンテキスト分離された下位エージェント。本プロジェクトでは監査観点ごとに 1 つずつ用意する | `src/subagents/` | subagent |
| 仮想ファイルシステム | Deep Agents が提供する抽象化されたファイル読み書き領域。`/raw/`, `/reports/`, `/memories/` のプレフィックスで用途を分離する | `src/fs-layout.ts` | virtual filesystem, vfs |
| 長期メモリ | `/memories/` プレフィックスに書かれたファイル。セッションをまたいで永続化され、次回実行時に復元される | `spec-005-long-term-memory` | long-term memory |
| HITL | Human-in-the-Loop。特定ツール実行前に LangGraph の `interrupt()` で人間の承認を挟む仕組み | `spec-006-human-in-the-loop` | human in the loop |
| Skills | Anthropic 発の「エージェントスキル」概念。`SKILL.md` を段階的開示で読み込ませ、ドメイン知識を注入する | `skills/`, `spec-007-skills-integration` | SKILL.md, エージェントスキル |
| Middleware (Deep Agents) | `wrap_tool_call` 的なデコレータでツール実行を wrap し、ログ・レート制限・バリデーションなど横断的関心事を差し込む層 | `src/middleware/`, `spec-008-middleware` | ミドルウェア |
| 監査観点 | OSS 監査における独立した評価軸。本プロジェクトでは license / security / maintenance / api-stability / community の 5 観点 + critic を採用 | `docs/prds/prd-mastra-audit-agent/prd.md` | audit aspect |
| Critic サブエージェント | 監査観点サブエージェント群が生成した raw データの整合性・ファクトエラーを機械的に検証する専用サブエージェント | `spec-004-critic-and-report` | critic |
| raw データ | サブエージェントが調査フェーズで生成する構造化中間データ。`/raw/<aspect>/` 配下に JSON で保存され、後段のレポート統合で読み込まれる | `src/fs-layout.ts` | raw artifact |
