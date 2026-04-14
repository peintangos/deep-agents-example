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

- [x] `skills/audit/` 配下に 5 観点分の SKILL.md を作成（詳細チェックリスト） — `license` / `security` / `maintenance` / `api-stability` / `community` の 5 ファイル。YAML frontmatter (name = directory 名, description, allowed-tools) + 本体 (判定基準テーブル + NG 例 + 出力契約) で統一。`tests/skills-audit.test.ts` で 26 ケース format 契約
- [x] `skills/report/zenn-style/SKILL.md` で文体ガイドラインを定義 — だ/である調 / 結論→根拠→含意 / 見出し構造 (`###` 3 段構成) / 総合判定テーブルテンプレ / critic findings の書き換えルール / 5 条件の出力契約を定義。`tests/skills-report.test.ts` で形式契約 5 + zenn-style 固有の内容契約 3 (だ/である調の言及 / Markdown table 構文 / `###` 見出し言及) を固定 (9 ケース)
- [x] `createDeepAgent()` の `skills` オプションに Skills ディレクトリを登録 — `src/agent.ts` に `DEFAULT_SKILLS_ROOT_DIR` (`import.meta.url` + `../skills`) と `DEFAULT_SKILL_SOURCES` (`/skills/audit/`, `/skills/report/`) を追加。`backend` factory を 3-way CompositeBackend (`/memories/` → StoreBackend, `/skills/` → FilesystemBackend{virtualMode}, default → StateBackend) に拡張し、`createDeepAgent` の `skills` オプションに連動。`CreateAuditAgentOptions` に `skillsRootDir` / `skills` の DI を追加。`tests/smoke.test.ts` に配線テスト 11 ケース追加 (exports 契約 3 + 構成スモーク 4 + CompositeBackend ルーティング 4 で、default rootDir / custom rootDir / zenn-style 読み出し / virtualMode traversal 拒否を証跡化)
- [x] サブエージェントにも必要な Skills を個別割り当て — 6 factory に `skills?: readonly string[]` オプションと `DEFAULT_<SUBAGENT>_SKILLS` 定数を追加。粒度は 3 階層: (1) 5 observation subagents は各自の 1 観点のみ (`/skills/audit/<aspect>/`)、(2) critic は例外的に `/skills/audit/` 全体 (クロス観点整合性のため)、(3) メインは `/skills/audit/` + `/skills/report/` の 2 ソース。各 factory の test ファイルに "default 一致" + "custom override" の 2 assertion を追加 (合計 12 tests 追加)
- [ ] テスト: 関連性マッチングで正しい Skill が読み込まれることを確認
- [ ] Review (typecheck + test + `/code-review`)
