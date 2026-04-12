# spec-003: 監査サブエージェント実装 (5 観点)

## Overview

Deep Agents の `subagents` オプションを使って、5 つの監査観点を担当するサブエージェントを実装する:

- **license-analyzer**: ライセンス種別と依存ライブラリ間の互換性
- **security-auditor**: 脆弱性スキャン（OSV API / npm audit）
- **maintenance-health**: コミット頻度、Issue 応答、バス係数
- **api-stability**: breaking change 履歴、SemVer 遵守度
- **community-adoption**: GitHub stars 推移、依存プロジェクト数、実運用事例

各サブエージェントは `system_prompt` と最小限のツールセットを持ち、raw データを `/raw/<aspect>/` 配下に書き出す。

## Acceptance Criteria

```gherkin
Feature: 5 つの監査サブエージェントが独立して動作する

  Background:
    メインエージェントが `task` ツールでサブエージェントに委譲できる

  Scenario: 各サブエージェントが独自の system_prompt を持つ
    Given サブエージェント定義が登録されている
    When メインエージェントが `task` で各サブエージェントを呼び出す
    Then それぞれが担当観点に特化したシステムプロンプトで動作する

  Scenario: raw データが仮想 FS に保存される
    Given license-analyzer サブエージェントが動作する
    When 対象 OSS のライセンスを調査する
    Then `/raw/license/result.json` に構造化データが保存される

  Scenario: サブエージェント間でコンテキストが独立している
    Given 複数のサブエージェントを連続で呼び出す
    When 一つのサブエージェントの会話履歴が膨らんでも
    Then 他のサブエージェントのコンテキストには影響しない
```

## Implementation Steps

- [x] `src/subagents/license-analyzer.ts` を実装しサブエージェント factory パターンを確立 (残り 4 観点は同じパターンで量産)
- [ ] `security-auditor` / `maintenance-health` / `api-stability` / `community-adoption` の 4 サブエージェントを追加
- [x] 各サブエージェントの system_prompt を監査観点ごとにチューニング (license-analyzer 完了、残り 4 件は次タスク)
- [x] 必要最小限のツールを各サブエージェントに割り当てる設計 (`LicenseAnalyzerOptions.tools` で DI 可能)
- [x] `src/agent.ts` でメインエージェントにサブエージェント群を登録 (license-analyzer のみ登録済み、残りは追加時に同じ要領)
- [x] 各サブエージェント単体のテスト (license-analyzer 5 ケース)
- [ ] Review (typecheck + test + `/code-review`)
