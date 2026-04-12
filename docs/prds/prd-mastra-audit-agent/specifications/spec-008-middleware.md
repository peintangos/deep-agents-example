# spec-008: Middleware 統合

## Overview

Deep Agents の `middleware` オプション（`wrap_tool_call` デコレータ）を使って、ツール実行の横断的関心事を実装する:

- **ツール呼び出しログ**: どのエージェント / サブエージェントがどのツールを何回呼んだかを構造化ログに記録
- **レート制限**: GitHub API のレート上限に達しそうな場合の間引き（1 リクエストあたり最小待機時間を挿入）
- **バリデーション**: ツール引数の事前チェック（不正なリポジトリ URL 等を弾く）

Middleware は "ツール呼び出しを wrap する" だけの薄い層にとどめ、ビジネスロジックは入れない。

## Acceptance Criteria

```gherkin
Feature: Middleware がツール呼び出しを横断的に処理する

  Background:
    deep agent に middleware が登録されている

  Scenario: ツール呼び出しがログに残る
    Given 監査を実行する
    When 任意のツールが呼ばれる
    Then `out/.state/tool-calls.jsonl` に構造化ログが追記される

  Scenario: GitHub API のレート制限が回避される
    Given GitHub API のレート残量が閾値以下
    When 次の API 呼び出しが発生する
    Then middleware が最小待機時間を挿入してから呼び出しを通す

  Scenario: 不正な引数が弾かれる
    Given リポジトリ URL が不正な形式
    When `fetch_github` ツールが呼ばれる
    Then middleware が呼び出しを拒否し、エラーを返す
```

## Implementation Steps

- [ ] `src/middleware/logging.ts` でツール呼び出しロギング middleware を実装
- [ ] `src/middleware/rate-limit.ts` で GitHub API レート制限対応 middleware を実装
- [ ] `src/middleware/validate.ts` で引数バリデーション middleware を実装
- [ ] `createDeepAgent()` の `middleware` オプションに登録
- [ ] テスト: 各 middleware が期待通りに wrap することを確認
- [ ] Review (typecheck + test + `/code-review`)
