# spec-004: critic サブエージェントとレポート統合

## Overview

監査観点サブエージェント群が生成した raw データを統合し、最終レポート (`out/mastra-audit-report.md`) を生成する。critic サブエージェントを一段挟むことで、観点間の矛盾やファクトエラーを機械的にチェックする。この spec の完了時点で、まだ長期メモリ / HITL / Skills / Middleware は入っていないが MVP の "動くもの" が通しで動く状態になる。

## Acceptance Criteria

```gherkin
Feature: critic サブエージェントと最終レポート生成

  Background:
    spec-003 の監査サブエージェント群が raw データを生成済みである

  Scenario: critic サブエージェントが raw データの整合性を検証する
    Given `/raw/` 配下に 5 観点の結果 JSON が存在する
    When critic サブエージェントが呼ばれる
    Then 観点間の矛盾や明らかに不十分な記述を検出し、検出結果を `/raw/critic/findings.json` に書く

  Scenario: 最終レポートが Markdown として生成される
    Given 全サブエージェントの raw データと critic の findings が揃っている
    When レポート生成が実行される
    Then `out/mastra-audit-report.md` が生成され、5 観点のセクションと findings セクションを含む

  Scenario: Mastra 以外の OSS にも同じフローで適用できる
    Given CLI に監査対象リポジトリを引数で渡す
    When 同じパイプラインで別の OSS を監査する
    Then 同じ構造のレポートが生成される
```

## Implementation Steps

- [x] `src/subagents/critic.ts` を追加し、system_prompt を整合性検証向けに設計
- [x] `src/reporter.ts` で raw データ群を読み込んで Markdown を生成する関数を実装
- [x] メインエージェントのオーケストレーションフローを更新し、監査 → critic → reporter の順で呼ぶ
- [ ] `out/` を git 管理外にする（`.gitignore` に追加）
- [ ] 最小 E2E テスト（モック raw データ → レポート生成）
- [ ] Review (typecheck + test + `/code-review`)
