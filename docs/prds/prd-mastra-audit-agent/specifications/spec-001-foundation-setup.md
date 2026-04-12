# spec-001: 基盤セットアップと deepagents smoke test

## Overview

TypeScript プロジェクトの雛形と、`deepagents` (JS 版) の最小動作確認を行う。deepagents JS 版の成熟度リスク（npm 公開版が未コンパイルで実用不可だった CrewAI TS SDK の前例）を早期に検証するため、他の実装より先に smoke test を通すことを最優先とする。

## Acceptance Criteria

```gherkin
Feature: 基盤セットアップと最小動作確認

  Background:
    本プロジェクトは TypeScript + Node.js 20 以上で構築する

  Scenario: TypeScript プロジェクトが npm でビルド可能
    Given リポジトリに tsconfig.json / src / tests が存在する
    When 依存インストールと型チェックを実行する
    Then エラーなく完了する

  Scenario: deepagents の最小エージェントが起動する
    Given ANTHROPIC_API_KEY が環境変数に設定されている
    When smoke test が createDeepAgent() で最小エージェントを生成し、簡単な prompt を 1 回だけ呼ぶ
    Then エージェントが messages を返し、例外を投げない

  Scenario: CLI エントリーポイントが help を出力する
    Given `scripts/run-audit.ts` が存在する
    When `npx tsx scripts/run-audit.ts --help` を実行する
    Then 利用方法の説明が標準出力に表示される
```

## Implementation Steps

- [x] `tsconfig.json` を生成（`strict: true`, `moduleResolution: bundler`, `target: ES2022`）
- [x] `src/` と `tests/` ディレクトリを作成し、最小の `src/index.ts` を置く
- [x] `package.json` の scripts に `typecheck` / `test` / `audit` を追加し、`ralph.toml` の `build_check` を `npm run typecheck` に更新
- [ ] `deepagents` / `@langchain/anthropic` を依存追加（`tsx` / `vitest` は scaffold で導入済み）
- [ ] `scripts/run-audit.ts` に CLI の最小実装（`--help` のみ対応）
- [ ] `tests/smoke.test.ts` で `createDeepAgent()` の最小動作を検証
- [ ] Review (typecheck + smoke test + `/code-review`)
