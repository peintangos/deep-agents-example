# spec-005: 長期メモリ統合

## Overview

Deep Agents の長期メモリ機能 (`/memories/` プレフィックス) を使って、セッションをまたいで保持すべき情報を永続化する。対象は以下:

- **監査ポリシー**: 観点ごとの重み付け、除外したいチェック項目
- **ユーザー好み**: レポート文体（だ/である調 vs ですます調）、優先する監査観点
- **過去の監査履歴**: 同じ OSS を再監査する際の差分取得用

`LangGraph Store` (InMemoryStore から開始し、必要なら SQLite に切替可能) と `use_longterm_memory: true` を使う。

## Acceptance Criteria

```gherkin
Feature: 長期メモリがセッションをまたいで保持される

  Background:
    Deep Agents に LangGraph Store が設定されている

  Scenario: 監査ポリシーがセッションをまたいで復元される
    Given 前回の監査実行で `/memories/audit-policy.json` が書かれた
    When 次回の監査実行でエージェントが起動する
    Then 同じポリシーがメモリから読み込まれる

  Scenario: 通常パスに書いたファイルはセッション終了で消える
    Given 通常パス `/scratch/temp.txt` に書き込む
    When セッションを終了して再起動する
    Then `/scratch/temp.txt` は存在しない

  Scenario: 過去の監査結果と比較できる
    Given `/memories/history/mastra-2026-04.json` に前回の結果が保存されている
    When 今回の監査を実行する
    Then エージェントが前回との差分を認識できる
```

## Implementation Steps

- [ ] `createDeepAgent()` の呼び出しに `store` と `use_longterm_memory: true` を追加
- [ ] `src/memory/policy.ts` で監査ポリシーの読み書きヘルパーを実装
- [ ] ユーザー好みの記録フロー（初回実行時に対話で記録し、次回以降は自動参照）
- [ ] 過去の監査履歴を `/memories/history/` 配下に JSON で保存
- [ ] テスト: セッション再起動前後でメモリが保持されることを確認
- [ ] Review (typecheck + test + `/code-review`)
