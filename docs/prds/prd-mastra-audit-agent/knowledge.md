# Knowledge — Mastra 監査エージェント MVP

## Reusable Patterns

<!-- Document patterns that should be reused in later tasks or later PRDs. -->

### read_raw / write_raw を独自 Tool にしない設計判断

spec-002 では当初 `read_raw` / `write_raw` / `fetch_github` / `query_osv` の 4 つを独自ツールとして実装する計画だったが、`read_raw` / `write_raw` は**独自 Tool にしないほうが正しい**という結論に至った。

理由:
1. deepagents は既に `read_file` / `write_file` / `edit_file` を default tool として提供している
2. deepagents の仮想 FS 状態は `filesystemMiddleware` が管理し、LangGraph の agent state に格納される
3. 独立した LangChain Tool から仮想 FS state にアクセスする標準的な API は無い (middleware 経由でないと整合性が壊れる)
4. 独自 `read_raw` / `write_raw` を作ると built-in と二重実装になり、どちらに書いたか分からない状態が生まれる

採用した代替案:
- サブエージェントは deepagents の built-in file tools (`read_file` / `write_file`) を使う
- パスは `src/tools/index.ts` が再 export する `rawPath(aspect, filename)` 等を使って system_prompt で組み立て方を指示する
- `/raw/<aspect>/` レイアウトは**規約**として system_prompt に埋め込み、型安全性は `AuditAspect` 型で担保する

### LangChain Tool の DI パターン

`createFetchGithubTool(client?)` のように client を optional 引数にしておくと、本番では `createFetchGithubTool()` で default client を内部生成し、テストでは `createFetchGithubTool(fakeClient)` で mock を注入できる。factory 関数で tool を返すことで、同じインターフェースでテスト/本番の両方をカバーできる。

tool の description には「どのサブエージェントが / 何のために使うか」まで書くと、LLM がツール選択を誤らないし、自分たちの仕様レビューにも役立つ。

### fetch ベースクライアントの DI 設計

GitHub / OSV API クライアントは octokit のような重い SDK を避け、Node 20 組み込みの `fetch` を薄くラップする構成にした。`createGitHubClient({ fetch: fakeFetch })` のように fetch を注入可能にしておくことで、単体テストで MSW のようなモッキング基盤を使わずに vi.fn だけで済む。

factory 関数 + closure 内部で `request<T>(path)` を共通化することで、後から `getCommits`, `getReleases` などを足すときに認証ヘッダや エラーハンドリングの重複を防げる。メソッドを増やすときは interface (`GitHubClient`) にも追加して外部契約を型で固定する。

### vitest + `noUncheckedIndexedAccess`: vi.fn の impl に引数型を明示する

`vi.fn(async () => { ... })` のように無引数の impl を渡すと、vitest は `Mock<[], ...>` と推論してしまい、`.mock.calls[0]` がタプルの範囲外アクセスになって TS2493 エラーを吐く。解決策は impl に `async (_input: string | URL | Request, _init?: RequestInit): Promise<Response>` のように**引数型と戻り値型を明示**すること。これで `.mock.calls[0]` が `[string | URL | Request, RequestInit | undefined] | undefined` と推論される。

テストアサーションは可能な限り `expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ headers: expect.objectContaining({...}) }))` のような matcher 形式を使い、`mock.calls[0]` の手動インデックスアクセスは body JSON のパースなど matcher で表現しにくいケースだけに絞るのが clean。

### 仮想 FS のパス分類: 末尾スラッシュ込みの startsWith が正解

`classifyPath("/raw/license/result.json") === "raw"` を実装するとき、うっかり `path.startsWith("/raw")` と書くと `/rawbit/data.json` も raw と誤判定してしまう (prefix 部分一致の罠)。正しくは `path.startsWith("/raw/")` のように**末尾スラッシュまで含めて** startsWith する。

同様に "/raw" のような裸のプレフィックス自体は "transient" 扱いにする (`/raw` は本来ディレクトリであって、ファイルパスとしては意味を持たない)。

### CLI: pure 関数 + 薄い entry 分離パターン

scripts/run-audit.ts にロジックを書くと、`import` した瞬間に `process.exit()` が発火してテストが書けない。対策として以下の分離を採用:

1. `src/cli.ts` に pure な `runCli(argv): CliResult` を実装。`process.exit` も `console.log` も呼ばず、`{ exitCode, stdout, stderr }` を返すだけ
2. `scripts/run-audit.ts` は `runCli(process.argv)` を呼んで結果を stdout/stderr に流し、最後に `process.exit(result.exitCode)` する薄い層
3. テスト (`tests/cli.test.ts`) は `runCli()` を直接呼び、subprocess spawn を避けて高速に検証する

この分離は後続 spec でも CLI に機能を足す時に使える。argv を受け取る pure 関数にしておくと、テスト側で `fakeArgv("--help")` のようなヘルパで引数を差し込める。

## Integration Notes

<!-- Capture cross-cutting behavior, dependencies, or setup details that are easy to forget. -->

- Deep Agents (TypeScript) は `npm install deepagents` でインストール可能。**実際の npm 最新版は v1.9.0**（リサーチ資料の v0.5 前提とは大きく異なる。API 形状は資料ベースのままでおおよそ使えるが camelCase (`interruptOn`, `systemPrompt`, `responseFormat` 等) と `memory?: string[]` のような新フィールドがあるので常に実物の型定義を正とする）。
- パッケージは `dist/index.d.ts` で型定義を同梱しており、TS2589 "Type instantiation is excessively deep" は発生していない。スマートな factory 関数を自前で書かず `createDeepAgent()` の戻り値を素直に return すれば問題なし。
- **デフォルトモデルは `claude-sonnet-4-5-20250929`**（PRD 起草時の "Claude Sonnet 4.6" という表現は、実体としてはこの 4.5 系列スナップショットを指す）。`src/agent.ts` では `DEFAULT_MODEL` 定数として export しておき、テストから参照可能にしている。
- サブエージェントは `systemPrompt` と `tools` を最小構成にし、raw データを仮想ファイルシステムに書き出す方針。
- GitHub API を呼ぶサブエージェントは `GITHUB_TOKEN` を環境変数経由で受け取り、Middleware で最小限のレート制限緩和を行う。
- **ESM / モジュール解決**: `tsconfig.json` は `module: ESNext` + `moduleResolution: bundler` を採用。vitest (Vite 基盤) は拡張子なし / `.js` 拡張子の import 両方を解決できる。`package.json` に `"type": "module"` は付けていないが、`tsx scripts/run-audit.ts` 実行時に問題が出たら追加を検討する。
- `deepagents` の transitive import で `langsmith/experimental/sandbox is in alpha` という stderr 警告が出るが、API を使っていないため無視してよい。

## Gotchas

<!-- Document pitfalls, edge cases, or failure modes. -->

- **TS2589 "Type instantiation is excessively deep"**: `createLLM()` のようにモデル工場関数を作ると、Runnable 型が再帰的に深くなって型エラーになる。サブエージェントに別モデルを注入するときに踏みやすい。回避策は `return new ChatAnthropic(...) as unknown as BaseChatModel` のように明示キャスト。過去のセッションで確認済みのパターン。
- **deepagents JS 版の成熟度 (2026-04-12 確認済み)**: CrewAI TS SDK の前例 (npm 公開版が未コンパイル) とは異なり、`deepagents@1.9.0` は `dist/` にコンパイル済み JS と `.d.ts` を同梱しており、TypeScript プロジェクトから直接 `import { createDeepAgent } from "deepagents"` で動く。成熟度リスクは解消。
- **長期記憶のスコープ**: `/memories/` プレフィックスで書かないとスレッドをまたいで永続化されない。通常パスに書いたファイルはセッション終了で消える。
- **TS18003 "No inputs were found"**: `include` パターン (`src/**/*.ts` 等) にマッチする .ts ファイルが 1 つもないと `tsc --noEmit` がエラーになる。`.gitkeep` は対象外なので、scaffold 時点で最小の `src/index.ts` を置く必要がある。本プロジェクトでは `export const PROJECT_NAME = "deep-agents-example"` を暫定配置し、`src/.gitkeep` は削除した。
- **npm audit の moderate 脆弱性 5 件 (2026-04-12)**: typescript + vitest + tsx + @types/node のみの状態で `npm audit` が moderate 5 件を報告。devDependencies 経由なのでランタイムには影響しないが、spec-004 の security-auditor サブエージェントで実装時に内容を検証し直すこと。`npm audit fix --force` は破壊的な更新を含む可能性があるのでここでは適用しない。

## Testing Notes

<!-- Record durable testing patterns, not one-off execution logs. -->

- smoke test は実 API を叩かず、deepagents の起動とツールバインドが成立するところだけ確認する。
- E2E テストは Mastra リポジトリを対象にして一回だけ実行し、結果の Markdown が期待するセクションを含むことを検証する。
