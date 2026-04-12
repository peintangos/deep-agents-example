# Roadmap

リポジトリ全体の方向性をまとめるドキュメント。個別の仕様進捗は各 PRD の `progress.md` を参照する。

## Current Focus

- **Mastra 監査エージェント MVP 実装**: LangChain Deep Agents (TypeScript) を使って Mastra OSS を多観点で監査するエージェントを構築する
- **Deep Agents の主要機能を必然性を持って使い切る**: プランニング / サブエージェント / 仮想ファイルシステム / 長期メモリ / HITL / Skills / Middleware を題材の中で自然に組み込む
- **Zenn 記事化**: 実装プロセスと知見を技術記事としてまとめる（Zenn 側は別リポジトリで管理）

## Active PRDs

- [`prd-mastra-audit-agent`](./prds/prd-mastra-audit-agent/prd.md) — Deep Agents (TypeScript) で Mastra を監査する MVP デモの実装

## Future Ideas

- 監査対象を Mastra 以外の OSS (Inngest, Convex, tRPC 等) に横展開して比較レポート化
- 監査レポートの自動差分取得（同じ OSS を定期実行して変化だけを通知する運用モード）
- v0.5 の async サブエージェントを使った並列監査の実証
- 監査観点の Skills 化を進めて、他プロジェクトでも再利用できるライブラリとして切り出す
