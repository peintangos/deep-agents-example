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

- [x] `src/middleware/logging.ts` でツール呼び出しロギング middleware を実装 — langchain の `createMiddleware({ wrapToolCall })` ベース。pure event builder (`buildToolCallLogEvent`) / JSONL 形式化 (`formatToolCallEventLine`) / file sink ラッパ (`createFileToolCallLogSink` + `appendToolCallEvents`) / middleware 本体 (`createToolCallLoggingMiddleware`) の 4 層分離。sink を DI にしてテストは in-memory array で決定論化。失敗時は sink に記録後 `throw` を rethrow してエージェントを欺かない。tests/middleware/logging.test.ts で 13 ケース (pure 4 + format 2 + file I/O 3 + E2E 4)
- [x] `src/middleware/rate-limit.ts` で GitHub API レート制限対応 middleware を実装 — min-interval 方式 (response header 非依存) で `DEFAULT_GITHUB_MIN_INTERVAL_MS=700` を固定、`fetch_github` をデフォルト対象に。pure `computeSleepMs` (null / elapsed≥interval / elapsed<interval / clock-skew cap の 4 分岐) + middleware factory (`now` / `sleep` を DI) の 2 層分離。tests/middleware/rate-limit.test.ts で 11 ケース (pure 4 + middleware 5 + exports 2)
- [x] `src/middleware/validate.ts` で引数バリデーション middleware を実装 — zod schema (空文字弾き) で足りない **GitHub 命名規則** を正規表現 + 個別チェックで 2 段目に重ねる。rejection は throw ではなく `ToolMessage(content: "[validate] ... rejected: ...")` で返し、LLM に補正を促す。`validateGithubRepoArgs` / `DEFAULT_TOOL_VALIDATORS = { fetch_github }` / `createValidateToolArgsMiddleware({ validators? })` の 3 層。tests/middleware/validate.test.ts で 19 ケース (pure 13 + middleware 4 + exports 2)
- [ ] `createDeepAgent()` の `middleware` オプションに登録
- [ ] テスト: 各 middleware が期待通りに wrap することを確認
- [ ] Review (typecheck + test + `/code-review`)
