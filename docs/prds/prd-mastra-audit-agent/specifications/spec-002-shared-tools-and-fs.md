# spec-002: 共通ツール基盤と仮想 FS レイアウト

## Overview

監査サブエージェント群で共通利用するツール（GitHub API / OSV API / ファイル書き込み）と、仮想ファイルシステムのディレクトリレイアウトを先に固める。各サブエージェントが raw データを書く場所・最終レポートを置く場所・長期メモリのスコープを分離することで、後続のスペック実装が並列化しやすくなる。

## Acceptance Criteria

```gherkin
Feature: 共有ツールと仮想ファイルシステムのレイアウト

  Background:
    メインエージェントとサブエージェント群が共通の FS レイアウトを使う

  Scenario: 仮想 FS のディレクトリレイアウトが定義されている
    Given プロジェクトが起動する
    When エージェントが仮想ファイルシステムを利用する
    Then `/raw/<aspect>/`, `/reports/`, `/memories/` の 3 つのプレフィックスで用途が分離される

  Scenario: GitHub API クライアントが再利用可能
    Given GITHUB_TOKEN が環境変数に設定されている
    When サブエージェントが GitHub の特定リポジトリのメタデータを取得する
    Then 統一したエラーハンドリング・レート制限対応が適用される

  Scenario: OSV API クライアントが再利用可能
    Given サブエージェントが依存ライブラリの脆弱性を調査する
    When OSV API に問い合わせる
    Then クエリ結果が JSON として統一フォーマットで返ってくる
```

## Implementation Steps

- [x] `src/fs-layout.ts` で仮想 FS のディレクトリ定数・型・ヘルパー (`rawPath`, `reportPath`, `memoryPath`, `classifyPath`) を実装
- [x] `tests/fs-layout.test.ts` で prefix 定数 / 観点型 / パスビルダー / classifier (prefix 部分一致の罠含む) を検証
- [x] `src/clients/github.ts` で `createGitHubClient` + `getRepo` + `GitHubApiError` を fetch ベースの DI 可能な薄いラッパとして実装
- [x] `src/clients/osv.ts` で `createOsvClient` + `query` + `OsvApiError` を実装
- [x] `tests/clients/` で各クライアントの happy path / 認証ヘッダ / エラーハンドリング / baseUrl 差し替えをカバー
- [ ] `src/tools/` 配下に共通のツール定義（`read_raw`, `write_raw`, `fetch_github`, `query_osv`）を配置
- [ ] Review (typecheck + test + `/code-review`)
