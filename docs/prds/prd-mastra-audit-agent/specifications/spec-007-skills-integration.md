# spec-007: Skills 統合

## Overview

Anthropic が提唱した「エージェントスキル」の概念を Deep Agents の `skills` オプションで取り込み、監査観点とレポート文体を外部ファイル (`SKILL.md`) として切り出す。段階的開示 (Progressive Disclosure) パターンにより、メインエージェントとサブエージェントで必要な知識だけが注入される。

切り出す Skills:

- `skills/audit/license/SKILL.md` — ライセンス監査のチェックリストと判断基準
- `skills/audit/security/SKILL.md` — 脆弱性スキャンの手順と重大度判定
- `skills/report/zenn-style/SKILL.md` — Zenn 記事に向いたレポート文体（だ/である調、比較表の使い方）

## Acceptance Criteria

```gherkin
Feature: Skills が段階的開示で読み込まれる

  Background:
    `skills/` ディレクトリに SKILL.md ファイル群が配置されている

  Scenario: 関連する Skills だけが注入される
    Given メインエージェントに全 Skills ディレクトリが登録されている
    When ライセンス監査のタスクが開始される
    Then `audit/license/SKILL.md` の内容がコンテキストに読み込まれ、無関係な Skills は読み込まれない

  Scenario: サブエージェントが独自の Skills を持てる
    Given critic サブエージェントに `audit/consistency/SKILL.md` が割り当てられている
    When critic が呼ばれる
    Then メインとは別のコンテキストで SKILL が読み込まれる

  Scenario: レポート生成時に文体 Skill が適用される
    Given `report/zenn-style/SKILL.md` がレポート生成フェーズで有効
    When 最終レポートが生成される
    Then 文体が SKILL.md の指示に従う（だ/である調、比較表あり）
```

## Implementation Steps

- [ ] `skills/audit/` 配下に 5 観点分の SKILL.md を作成（詳細チェックリスト）
- [ ] `skills/report/zenn-style/SKILL.md` で文体ガイドラインを定義
- [ ] `createDeepAgent()` の `skills` オプションに Skills ディレクトリを登録
- [ ] サブエージェントにも必要な Skills を個別割り当て
- [ ] テスト: 関連性マッチングで正しい Skill が読み込まれることを確認
- [ ] Review (typecheck + test + `/code-review`)
