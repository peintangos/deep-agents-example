# spec-009: Mastra を対象にした E2E 実行と最終レポート生成

## Overview

全機能（基盤 + サブエージェント + critic + 長期メモリ + HITL + Skills + Middleware）が揃った状態で、実際に Mastra リポジトリを対象に監査を E2E で実行し、最終レポート `out/mastra-audit-report.md` を生成する。Zenn 記事のハイライト部分を構成する。

## Acceptance Criteria

```gherkin
Feature: Mastra を対象に E2E 監査を実行する

  Background:
    spec-001 から spec-008 までが完了している

  Scenario: 監査を CLI から実行する
    Given 環境変数 ANTHROPIC_API_KEY と GITHUB_TOKEN が設定されている
    When `npx tsx scripts/run-audit.ts --target mastra-ai/mastra` を実行する
    Then エージェントが全サブエージェントを呼び、HITL を経由して最終レポートを生成する

  Scenario: 最終レポートが期待する構造を持つ
    Given E2E 監査が完了した
    When `out/mastra-audit-report.md` を開く
    Then 以下のセクションが含まれる: ライセンス / セキュリティ / メンテナンス健全性 / API 安定性 / コミュニティ採用 / critic の整合性レポート / 総合所見

  Scenario: 過去実行履歴が長期メモリに保存される
    Given 監査が完了した
    When 同じターゲットで再実行する
    Then エージェントが前回の結果を認識し、差分だけを更新する
```

## Implementation Steps

- [x] `scripts/run-audit.ts` の CLI に `--target` オプションを追加し、任意の GitHub リポジトリを指定可能にする — `src/cli.ts` に pure 関数 `parseTargetArg` (形式チェック: ちょうど 1 つの `/` で分割可能かだけを見る) と `buildAuditPrompt` (対象 identity だけを含む薄いユーザープロンプト、監査手順は AUDIT_SYSTEM_PROMPT 側に集約して drift を防ぐ) を export。意味的バリデーション (GitHub 命名規則 regex + trailing-hyphen) は spec-008 の `validateGithubRepoArgs` を再利用して重複を避ける。`--invoke` と `--target` は排他 (どちらも invoker へプロンプトを渡す入口のため、優先順位を曖昧にしない)。tests/cli.test.ts に 14 ケース追加、合計 333 tests 全通過
- [ ] Mastra (`mastra-ai/mastra`) を対象に E2E 実行し、実環境での挙動を検証する
- [ ] 出力された `out/mastra-audit-report.md` を人間がレビューし、Zenn 記事向けに気になる点を `knowledge.md` に追記
- [ ] `out/.state/tool-calls.jsonl` から記事用の統計（ツール呼び出し回数、HITL 介入回数など）を抽出
- [ ] Review (E2E が通る + `/code-review` + 最終レポートの目視確認)
