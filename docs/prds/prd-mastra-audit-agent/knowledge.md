# Knowledge — Mastra 監査エージェント MVP

## Reusable Patterns

<!-- Document patterns that should be reused in later tasks or later PRDs. -->

### deepagents SubAgent の型契約と filesystemMiddleware の自動付与

deepagents v1.9 の `SubAgent` interface は以下が**必須**:

- `name: string`
- `description: string`
- `systemPrompt: string`

**任意**:

- `tools?: StructuredTool[]` — 未指定の場合、deepagents の `defaultTools` が使われる
- `model?: LanguageModelLike | string` — 省略時はメインエージェントの model を継承
- `middleware?` / `skills?` / `interruptOn?` / `responseFormat?`

型で注意すべきこと:
- `SubAgent.tools` は **`StructuredTool`** (concrete abstract class) を要求する。`StructuredToolInterface` では TS2322 エラーになる
- `tool()` ヘルパが返す `DynamicStructuredTool` は `StructuredTool` を継承しているので、そのまま渡せる

**filesystemMiddleware の自動付与**: サブエージェントには `createDeepAgent` が自動で default middleware stack (`todoListMiddleware` / `filesystemMiddleware` / `summarizationMiddleware` 等) を適用する。そのため **`read_file` / `write_file` / `edit_file` はサブエージェント側に tools を明示しなくても使える**。カスタムツール (`fetch_github` 等) だけを `tools` に入れれば十分。

ただし **skills と違って default tools は main agent から継承しない** 点に注意。サブエージェントが main agent と同じ user-defined tool を使いたければ、同じ tool 参照を両方に渡す必要がある。

### サブエージェント factory パターン (license-analyzer がリファレンス)

共通の DI パターン:

\`\`\`ts
export interface XxxOptions {
  readonly tools?: readonly StructuredTool[];
}

export function createXxxSubAgent(options: XxxOptions = {}): SubAgent {
  const tools = [...(options.tools ?? [createDefaultTool()])];
  const outputPath = rawPath("<aspect>", "result.json");
  return {
    name: "xxx-analyzer",
    description: "...",
    systemPrompt: \`... ミッション / 出力フォーマット / 利用可能ツール / 原則 ...\`,
    tools: tools as StructuredTool[],
  };
}
\`\`\`

system_prompt には必ず次の 4 セクションを入れる:
1. ミッション (番号付きリスト)
2. 出力フォーマット (JSON Schema 風)
3. 利用可能ツール (ツール名 + 用途)
4. 原則 ("ファクト重視" / "不明点は unknown" / "推測禁止")

これでサブエージェント 5 本を量産するときの迷いが最小になる。

**量産時のテストで引っかかったケース (api-stability)**: テストで \`systemPrompt.toContain("SemVer")\` を検証していたが、プロンプト本体に "SemVer" 文字列を入れ忘れていた (コードコメントにだけ書いていた)。テストは**仕様アサーションとしても機能する**ので、失敗したら「テストが期待する用語がプロンプトに足りない = その概念を LLM に伝え損ねている」と解釈して、プロンプトに用語を追加する形で直すのが筋。逆にすることも可能だがプロンプトの意図伝達力が落ちる。

### critic サブエージェントは `tools` 未指定で default に委ねる

critic は 5 観点の raw データ (`read_file`) と findings 出力 (`write_file`) しか要らないので、**`tools` フィールドを設定しない**のが正解。deepagents の `filesystemMiddleware` が自動で `read_file` / `write_file` / `edit_file` を供給してくれるので、critic 側で `tools: []` や `tools: [builtinReadFile]` のような明示をすると、むしろ "default tools を上書きしてしまう" 事故の温床になる。

factory 関数としての **インターフェース統一** は `CriticOptions.tools` を optional で受け取りつつ、未指定時は `agent.tools` を**設定しない**という条件分岐で保つ:

\`\`\`ts
const agent: SubAgent = { name, description, systemPrompt };
if (options.tools) {
  agent.tools = [...options.tools] as StructuredTool[];
}
return agent;
\`\`\`

これで license-analyzer 等の「ツール注入系 factory」と同じ呼び出し方を保ちつつ、critic は default tools を失わずに済む。テストでも `expect(subagent.tools).toBeUndefined()` を明示的に検証しておくと将来の誤変更を防げる。

### 観点間検証サブエージェントの system_prompt は "入力パスを全部列挙する"

critic のような「複数の raw データを横断して検証する」サブエージェントでは、system_prompt のミッション欄に**読むべき raw パスを全部ベタ書きする**のが効く。`rawPath("license", "result.json")` 等を JS 側で構築して template literal に埋め込むことで、パスが変わったときにサブエージェントの指示も自動追従する (ハードコードを一箇所に集約)。

さらに「overall_assessment の判定基準」のような**導出ルール**を prompt に書いておくと、LLM の出力が安定する。列挙型 (`"pass" | "warnings" | "blocked"`) だけでなく**どういう条件でどれを出すか**を同時に示すのがポイント。

### reporter は pure function に徹する (I/O は呼び出し側)

`src/reporter.ts` の `generateAuditReport(input)` は**副作用ゼロの純粋関数**として実装した。ポイント:

1. **raw データは `Readonly<Record<string, unknown>>` で受ける**: サブエージェントの出力契約はプロンプト内の JSON Schema 文字列として定義されているだけで、TypeScript の型としては縛っていない。reporter は未知フィールドを捨てずに `JSON.stringify(data, null, 2)` でそのまま埋め込み、失われる情報をゼロにする。観点ごとの出力スキーマが安定したら段階的に型を狭めればよい。
2. **critic findings だけは typed にする**: `CriticSeverity` / `CriticOverallAssessment` を列挙型で定義。severity 順 (`critical > warning > info`) でのソートや Markdown のバッジ表示に使うため、ここだけは構造を確定させている。
3. **ファイル書き込みを含めない**: 仮想 FS 上のデータと実ファイル (`out/*.md`) の両方で同じ関数を使い回せるように、reporter は **文字列を返すだけ**。`out/` への write はオーケストレーション層 (agent.ts) が担う。cli.ts で確立した "pure 関数 + 薄い entry" 分離と同じパターン。
4. **欠落データ (`null`) への寛容さ**: 5 観点 / critic のいずれかが未取得 / 未実行のケースを `*raw データ未取得*` / `*critic 未実行*` のプレースホルダで明示的に扱う。テストで欠落ケースを検証しておくと、サブエージェントが一部失敗しても "レポートは出る" 保証になる。

テスト側では `baseInput(overrides)` ヘルパで固定データを組み、`overrides` で部分上書きするパターンを採った (`Partial<Input>` + スプレッド)。これで 10 ケースが記述量ほぼ同じで書ける。

### メインエージェントの system_prompt は "2 フェーズ + 完了条件 + 境界" を明示する

`AUDIT_SYSTEM_PROMPT` は deepagents のオーケストレーション用プロンプト。サブエージェント 6 本を正しく順番で呼ばせるには、次の 4 要素を書き分けるのが効く:

1. **Phase 1 (監査)**: 5 観点を並列委譲可と明示 (deepagents の `task` ツールは並列実行可能)。各観点の名前と担当サブエージェント名 (`license-analyzer` 等) と出力先パス (`/raw/license/result.json`) を表にしてマッピングする
2. **Phase 2 (検証)**: critic 委譲の順序制約を明文化。「Phase 1 が終わる前に critic を呼んではいけません」と禁止事項の形で書く方が守られやすい
3. **完了条件**: 6 ファイルをチェックリストで列挙し、「これが揃ったら終わり」と明言する。曖昧な "最終レポート生成" ではなく、LLM が判定可能な物理条件にする
4. **境界 (スコープ外の宣言)**: Markdown への統合は `src/reporter.ts` (外部の pure 関数) の仕事であり、エージェント自身は Markdown を組み立てないことを明記する。これを書かないと LLM が自前で `write_file` して Markdown を出力しようとし、reporter と二重実装になる

テストでは `Phase 1` / `Phase 2` の**出現順序** (`indexOf` 比較) と、6 つの raw パスの存在、境界の宣言 (`Markdown を 組み立てません`) を assert しておくと、将来のプロンプト改訂で順序や境界を壊してもすぐ検出できる。

### deepagents subagents 配列への追加は import + push の 2 行で済む

spec-003 で factory パターンを確立してあるおかげで、critic を追加するときの変更は `import { createCriticSubAgent }` と `subagents: [... , createCriticSubAgent()]` の 2 行だけ。パターンさえ整えば N 個目の追加コストは極めて低いので、最初に factory 統一にこだわる時間は後で回収できる。

### 生成物ディレクトリ (`out/`) はテンプレート初期化時点で既に gitignore / tsc exclude 済み

Ralph Matsuo テンプレートの `init-repo` 段階で、`.gitignore` の "Build output" セクションに `out/` が、`tsconfig.json` の `exclude` に `"out"` が**両方**敷かれていた。spec-004 の「`out/` を git 管理外にする」タスクは実質ノーオペで、新規追加不要だったことを確認。

これは「生成物ディレクトリは tsc からも git からも外す」という対称な契約が初期テンプレートに埋め込まれていた例。同様のパターン (`dist/`, `build/`, `coverage/`, `.next/` も既存) があるので、PRD で出力ディレクトリを追加するときは「テンプレートが既にカバーしているか」を最初にチェックすると無駄なコミットが減る。

### E2E テストは "pure + thin wrapper" の wrapper 側に向けて書く

spec-004 の受け入れ条件は `out/mastra-audit-report.md` が**実ファイルとして生成されること**だった。pure な `generateAuditReport` だけでは満たせないため、`writeAuditReport(input, outputPath)` という**副作用を持つ薄いラッパ**を別途 export した (中身は `generateAuditReport` + `mkdir({recursive:true})` + `writeFile` の 3 行)。

この 2 関数構成は CLI で確立した "pure 関数 + 薄い entry" 分離の再現で、テスト戦略もそのまま流用できる:

1. **ユニットテスト** (`tests/reporter.test.ts`): pure 関数 `generateAuditReport` を呼び、返り値の文字列に対して 10 ケース検証する。ディスクに触らないので高速・決定論的
2. **E2E テスト** (`tests/audit-pipeline.e2e.test.ts`): `beforeEach` で `mkdtemp(tmpdir(), "audit-pipeline-e2e-")` し、`writeAuditReport` を呼んだあと `stat` + `readFile` で実ファイルを検証。`afterEach` で `rm(workdir, { recursive: true, force: true })` でクリーンアップ
3. **LLM を伴う本物の E2E** (spec-009 予定): OpenRouter / GitHub API を実際に叩くパイプライン E2E は別レイヤに分離

E2E テストでは **idempotency** (2 回実行で同じ内容になる) と **intermediate dir auto-create** (`out/deeply/nested/` のようなパスも事前 mkdir 不要) を検証しておくと、オーケストレーション層からこのラッパを使うときの前提条件が守られる。モック raw データは E2E ファイルの中に `mockInput()` ヘルパとして閉じ込め、reporter.test.ts の `baseInput()` と**意図的に重複を許す** (E2E は独立して動かせることを優先)。

### deepagents v1.9 の長期メモリ配線: store + CompositeBackend(/memories/ → StoreBackend)

**重要**: spec-005 は当初 Python 版由来の `use_longterm_memory: true` フラグを想定していたが、**deepagents TS v1.9 にそのフラグは存在しない**。型定義 (`node_modules/deepagents/dist/index.d.ts`) を一次ソースとして確認済み。正しい配線は以下:

\`\`\`ts
import {
  createDeepAgent,
  CompositeBackend,
  StateBackend,
  StoreBackend,
} from "deepagents";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

createDeepAgent({
  // ...
  store: new InMemoryStore(),  // ← LangGraph の BaseStore
  backend: (config) =>
    new CompositeBackend(new StateBackend(config), {
      "/memories/": new StoreBackend(),  // ← プレフィックスルーティング
    }),
});
\`\`\`

**配線のメンタルモデル**:

1. **`store` を渡すだけでは不十分**: `createDeepAgent` のデフォルト backend は `(config) => new StateBackend(config)` (`node_modules/deepagents/dist/index.js` line 6457 で確認)。つまり `store` だけ渡しても StateBackend は store を使わず、`/memories/` 配下も ephemeral になってしまう
2. **`CompositeBackend` で明示ルーティング**: `{ "/memories/": new StoreBackend() }` と指定することで、`/memories/` 配下の書き込みだけが StoreBackend 経由で `BaseStore` に流れる。他のパス (`/raw/`, `/reports/` 等) は StateBackend に行き session-local に留まる
3. **`new StoreBackend()` は zero-arg で OK**: 内部で `getLangGraphStore()` 経由で実行コンテキストから `store` を取得する設計。`createDeepAgent({ store })` がそのコンテキストを提供する
4. **CompositeBackend の prefix 照合は末尾スラッシュ込み**: fs-layout.ts の `classifyPath` と同じく、ルートキーは `/memories/` (trailing slash) を書く。`/memories` にすると prefix 一致の罠にハマる (これは spec-002 の `classifyPath` 実装で学んだ教訓の再利用)

**DI パターン**: `createAuditAgent({ store? })` で BaseStore を optional 注入可能にしておくと:
- テスト: `new InMemoryStore()` を明示的に渡して状態を分離
- プロダクション: SQLite / Postgres 裏打ちの BaseStore に差し替え
- 同プロセス内での "セッション跨ぎ共有": 呼び出し側で 1 つの `InMemoryStore` を作って両方の `createAuditAgent` 呼び出しに渡す

**spec 記述の API gap は記録して読み替え**: spec-005 の Implementation Steps に書かれていた `use_longterm_memory: true` は Python 版由来。spec を破棄せず「v1.9 API に合わせて CompositeBackend 配線に読み替え」という注釈を spec 本体に追記した。これは**ドキュメントを正、コードを実装** の原則を守りつつ、一次ソース (型定義) との差分に気づいたら spec 側を更新する流れ。

**テスト戦略の段階化**: 「store 注入の配線が壊れない」を smoke test で確認 (agent 生成が throw しない + store API を直接叩いて put/get が動く) するのが最小単位。**実際に `/memories/` パスが StoreBackend 経由で永続化される** 統合テストは、`createAuditAgent` を LLM 呼び出しと独立して動かすのが難しいため、後続の spec-005 統合テストタスクで別途扱う。smoke レベルで「配線 gap」を早期に捕捉し、integration レベルで「動作 gap」を捕捉する 2 段階が効く。

### `/memories/` を agent の外から読み書きする規約 (BaseStore 直結ヘルパー)

`createDeepAgent({ store, backend: CompositeBackend(..., { "/memories/": new StoreBackend() }) })` を配線したあと、CLI / テスト / セットアップスクリプトのような **agent の外側** から `/memories/` のデータを読み書きしたいことがある (監査ポリシーの seed、ユーザー好みの初期化、過去履歴の参照など)。`StoreBackend` の内部 API には依存せず、注入した `BaseStore` を直接叩くのが最も低結合で、`src/memory/store-helpers.ts` がその規約を一箇所に閉じ込めている。

**規約 3 点**:

1. **namespace は `["filesystem"]`**: deepagents v1.9 の `StoreBackend.getNamespace()` は zero-arg 構築時に固定値 `["filesystem"]` を返す (`node_modules/deepagents/dist/index.js` line 4275 で確認)。`new StoreBackend()` を直接 agent.ts で使っているため、helper 側もこの namespace で揃える
2. **キーは `/memories/` プレフィックスを剥がした絶対パス**: `CompositeBackend.getBackendAndKey` が `/memories/audit-policy.json` を `[backend, "/audit-policy.json"]` に変換してから StoreBackend に渡す (line 5183-5187)。helper 側で `store.put(["filesystem"], "/audit-policy.json", ...)` のように **`/memories/` を含めずに** put するのが正しい。ここを間違えると agent 側の `read_file("/memories/...")` で読めなくなる
3. **値は FileData v2 形状**: `{ content: string, mimeType?: string, created_at: ISO, modified_at: ISO }`。`StoreBackend.convertStoreItemToFileData` は `content` / `created_at` / `modified_at` の 3 フィールドを必須としており、これらが欠けると agent 側の read で「Store item does not contain valid FileData fields」エラーで弾かれる (line 4286)。`mimeType` は省略可能だが `"application/json"` を入れておくと一貫性が保てる

**`memoryStoreKey()` のテスト戦略**: 「`/memories/` で始まる正常系」「`/memories/history/<file>` のネスト」「`/raw/` のような prefix 不一致を弾く」「`/memories/` 単体を弾く」の 4 ケースで縛っておくと、後続の preferences / history ヘルパーで同じ規約を再実装したくなる誘惑を抑制できる。

**`created_at` 保持は get → put の 2 段階で行う制約**: `writeMemoryJson` は既存値を `store.get` で取り出して `created_at` を再利用してから `store.put` で書き戻す。`InMemoryStore` のような単一プロセスの store では問題ないが、SQLite / Postgres 裏打ちの BaseStore に差し替えると同一キーへの並行書き込みで `created_at` がフリップする race が理論上残る。プロダクションで永続 store に切り替える際は backend 側の atomicity (transaction / compare-and-swap) で守るか、`created_at` を helper 側ではなく外側のメタデータレイヤで管理する設計に切り替えるのが筋。

**helper 側 `store.put` と agent 側 `write_file` の非対称性**: helper の `writeMemoryJson` は `store.put` を直接呼ぶためアップサート (上書き) が成立する。一方 deepagents の `write_file` ツールは内部で `StoreBackend.write` を呼び、line 4428 で「既存ファイルへの write はエラー」と弾く。このため CLI 側で先に `/memories/audit-policy.json` を seed したあと、agent 側から同じパスに書きたい場合は **`edit_file` を使う必要がある** (`write_file` だと "Cannot write because it already exists" で失敗する)。逆向きの round-trip (agent が write → helper が read) は問題なく動く。

### Anthropic Skills: system prompt との責務分離と命名契約

spec-007 で導入した Skills (`skills/audit/*/SKILL.md` ほか) は **LLM に渡す知識ベース**という第 3 の層で、コード (動く論理) ともドキュメント (人間向け) とも責務が違う。設計上の要点:

**system prompt と SKILL.md の責務分離**:

| レイヤ | 責務 | 例 |
|---|---|---|
| サブエージェント `systemPrompt` | ミッション / 出力契約 / 利用可能ツール / 原則 (常に context に載る短い指示) | "ライセンスの SPDX を特定し /raw/license/result.json に書け" |
| `SKILL.md` body | 詳細な判定基準 / NG 例 / 出力スキーマのサンプル (必要なときだけ段階的開示) | "Elastic-2.0 は restricted と判定せよ" + NG 例 + JSON サンプル |

system prompt を膨張させずに**「細かい判断ルールは SKILL に逃がす」**のが spec-007 の価値。system prompt は全タスクの毎呼び出しで context に載るのでトークン課金に直結するが、SKILL は LLM が「この skill 要る」と判断したときだけ読み込まれる (progressive disclosure)。

**Anthropic Skills の frontmatter 契約** (deepagents v1.9 の `parseSkillMetadataFromContent` + `validateSkillName$1` で強制される):

1. `name` は **lowercase alphanumeric + 単一ハイフンのみ**。先頭 / 末尾ハイフン禁止、連続 `--` 禁止
2. `name` は**親ディレクトリ名と完全一致**必須。`skills/audit/license/SKILL.md` なら `name: license`
3. `description` は必須で 1024 文字以内 (超えると切り捨て)
4. オプション: `allowed-tools`, `compatibility`, `license`, `metadata`

**tests/skills-audit.test.ts** で 5 ファイル × 5 チェックの 25 ケース + ドリフト検出 1 ケースを固定。deepagents 側でも `validateSkillName$1` が走るが、**外側 (repo 側)** で同じ契約を縛っておくと:
- ディレクトリリネーム時に skill が silently 読み込み失敗するのを即検出
- deepagents のバージョンアップで contract が変わったときも自前テストが目印になる
- SKILL.md 本体が空のスケルトン (`name` / `description` だけで body なし) を弾ける (本体長さ > 200 文字の境界値)

**本プロジェクト固有の SKILL 構造**: 5 つの audit skill は以下の構造で統一している:

1. このスキルを使うタイミング (matching のヒント)
2. 主要指標 / 判定基準テーブル (表形式)
3. NG 例 (LLM がハマりがちなミス)
4. 出力契約 (`/raw/<aspect>/result.json` のサンプル)

この 4 セクション構成で 5 ファイルを量産すると、サブエージェントの system prompt は「スキルに従え」と書くだけで詳細を外に逃がせる。knowledge.md にノウハウを書くのと似た構造だが、**対象読者が人間 (knowledge.md) vs LLM (SKILL.md)** という違いがあり、SKILL.md の方が具体的なテーブルと NG 例を多めに詰める。

### `fakeModel` の bindTools callIndex 問題と factory-based 回避策

`@langchain/core/testing` の `fakeModel()` で HITL interrupt/resume の E2E を書くとき、**queue ベースの respond/respondWithTools はほぼ確実に壊れる**。原因は `bindTools()` 実装 (`node_modules/@langchain/core/dist/testing/fake_model_builder.js:120-127`):

\`\`\`js
bindTools(tools) {
  const next = new FakeBuiltModel();
  next.queue = this.queue;          // ← shared by reference
  next._callIndex = this._callIndex; // ← COPIED by value
  return next.withConfig({});
}
\`\`\`

新しい `FakeBuiltModel` インスタンスは queue を共有するが `_callIndex` は値コピー。`createAgent` が invoke ごとに bindTools を呼び直すと、毎回新しいカウンタが誕生して **queue[0] を何度も消費**し、queue[1] 以降に到達しない。結果として:

- 初回 invoke: queue[0] (respondWithTools) → tool_call → interrupt ✓
- 2 回目 invoke (Command resume): 新しい binding、callIndex=0 → queue[0] を再消費 → また tool_call → また interrupt (**無限ループ**)

**回避策は "queue 位置に依存しない factory-based respond"**:

\`\`\`ts
const model = fakeModel().respond((messages: BaseMessage[]) => {
  const last = messages[messages.length - 1];
  if (last && ToolMessage.isInstance(last)) {
    // tool が実行済み → 最終 AIMessage で終了
    return new AIMessage("監査完了");
  }
  // 初回 → tool_call を発行して HITL 中断を誘発
  return new AIMessage({
    content: "",
    tool_calls: [{ name: "external_probe", args: {...}, id: "tc1", type: "tool_call" }],
  });
});
\`\`\`

queue には **1 つの factory だけ** を入れ、factory が messages を見て応答を決める。これで bindings 境界を越えても挙動が決定論的になる。2 つの独立した thread で別のレスポンスを返したい場合も、factory 内で human message の内容から target を抽出すれば OK。

**教訓の一般化**: モックは **「状態より関数で書け」**。queue 位置依存の mock は mock consumer 側の呼び出し戦略 (bindings, キャッシュ, re-instantiation) に簡単に壊されるが、pure function mock は入力だけ見れば答えが決まるので呼び出し戦略に依存しない。テストで state-ful mock を使うときはまずこの観点で設計を疑う。

### E2E テストでは langchain の `createAgent` を直接叩く (deepagents の重量級 middleware を避ける)

spec-006 の interrupt/resume E2E では **`createDeepAgent` ではなく langchain の `createAgent`** を直接使った。理由:

1. `createDeepAgent` は `summarizationMiddleware` / `todoListMiddleware` / `filesystemMiddleware` などを自動注入し、それらが内部で model を叩くため `fakeModel.callCount` が膨らんで切り分けが困難になる
2. `BASE_AGENT_PROMPT` が system prompt に連結されるので、`fakeModel` の content derivation が想定外の文字列を返す
3. HITL ロジックの検証に必要な最小要素は「tool を 1 つ持つ agent + HITL middleware + checkpointer」で、deepagents の他の機能は論点外

`createAuditAgent` 側の HITL 配線は `tests/smoke.test.ts` の 6 ケースで別途検証されており、**実際に HITL middleware が走る動作証跡** は本 E2E で取る、という 2 段階のテスト戦略。createDeepAgent の重量級な振る舞いを毎回 E2E で再現する必要はなく、むしろノイズになる。

### HITL ログは物理ファイル (`out/raw/hitl/log.jsonl`) に書く

spec-006 の 3 番目のタスクで HITL 判断ログを JSONL で永続化した。`src/hitl-log.ts` が pure 関数 (`createHitlLogEvent` / `formatHitlEventLine`) と I/O 関数 (`appendHitlEvents` / `readHitlEvents`) の 2 層で構成されている。

**論理パスと物理パスの分離**: spec 本文の「`/raw/hitl/log.jsonl`」という表記は論理パス (agent の仮想 FS を連想させる)。しかし HITL は **CLI 層 (`scripts/run-audit.ts`) で emit されるイベント** で、agent の仮想 FS の writer chain には乗らない。したがって実体は物理ファイルで、デフォルトパスを `out/raw/hitl/log.jsonl` にして**論理的な階層と物理的な配置を一致** させた (かつ `out/` は spec-004 で `.gitignore` 済み)。

**JSONL 採用の根拠**:

1. **append-only フォーマット**なので CLI クラッシュや `kill -9` で途中行が欠けても残りの有効な行を使える
2. `JSON.stringify(event) + "\n"` の **愚直な serializer** で十分。バイナリフォーマットや DB を入れる必要はない
3. 読み出し側 (`readHitlEvents`) は **壊れた行をスキップ**して有効行だけ返す。1 行の損害を全体に波及させない。これが無いと append 中の crash 復旧で過去の判断履歴全部を失う
4. Zenn 記事や監査レポートのメタデータとしても使いやすい (`jq` で直接 grep 可能)

**`appendHitlEvents([])` は no-op**: 空配列を渡されたら一切 I/O を起こさない。HITL ループで interrupt の `actionRequests` がゼロ件の極端ケース (現状起きないが API 上はあり得る) を誤って空ファイル作成で汚さないための小さな不変条件。これを仕込むと呼び出し側で `if (events.length > 0)` の防御を書かなくて済む。

**index ベースのペアリングは `resolveHitlInterrupt` の順序保存に依存する**:

\`\`\`ts
// resolveHitlInterrupt は actionRequests の順序を保ってそのまま decisions に詰めるため、
// index ベースで action[i] ↔ decisions[i] が正しく対応する。
for (let i = 0; i < actions.length; i++) {
  const action = actions[i];
  const decision = response.decisions[i];
  if (!action || !decision) continue;
  events.push(createHitlLogEvent(action, decision));
}
\`\`\`

この契約は `tests/hitl.test.ts` の "produces one decision per actionRequest (preserving order)" で縛られている。将来 `resolveHitlInterrupt` が action を並び替える実装に変えたら、**テストが赤くなるし、HITL ログのペアリングも破綻する** — この 2 箇所が**同じ不変条件**に依存していることをコメントで明示しておくのが、後の regression 調査を楽にする。

**pure vs I/O の分離パターン (3 回目の再利用)**: reporter (`generateAuditReport` / `writeAuditReport`)、hitl (`detectHitlInterrupt` / `runHitlLoop`)、hitl-log (`formatHitlEventLine` / `appendHitlEvents`) のすべてが同じパターンで書かれている。pure 関数 (決定論的ユニットテスト) + 薄い I/O ラッパ (tmpdir E2E) の 2 層で、テスト戦略も統一できる。このパターンを繰り返すのが本プロジェクトの一貫性の源泉。

### HITL 実行ループ: pure core + thin entry で interrupt/resume を書く

spec-006 の 2 番目のタスクで CLI 側の HITL ハンドラを実装した。`src/cli.ts` 本体は触らず、新規に **`src/hitl.ts`** に pure core を置き、`scripts/run-audit.ts` に対話 I/O (readline-based policy) と実行ループを薄く載せる 2 層構成にした。

**pure core (`src/hitl.ts`) に置くもの**:

1. `detectHitlInterrupt(state)` — `state.__interrupt__?.[0]` を返すだけ。ただし型ガードで null / 非配列 / プリミティブを全部弾く (runtime で壊れた state を受け取っても throw しない)
2. `resolveHitlInterrupt(interrupt, policy)` — 各 `ActionRequest` に policy を適用して `HITLResponse` を組み立てる。`reviewConfigs` との対応付けは actionName での先着優先 Map 索引
3. `formatActionForHuman(action, review)` — 多行文字列の整形。JSON.stringify の例外 (循環参照) を catch してフォールバックメッセージを返すのがポイント — 実運用で agent が壊れた state を吐いたときに CLI が落ちるのを防ぐ
4. `APPROVE_ALL_POLICY` / `REJECT_ALL_POLICY` — CI やテスト用のプリセット。preset を export しておくと後続テストで `fakePolicy = APPROVE_ALL_POLICY` で 1 行 DI できる

**thin entry (`scripts/run-audit.ts`) に置くもの**:

1. `consolePolicy` — readline で stdin/stdout を掴んで承認/却下を聞く。**action ごとに `rl` を開閉**する実装にしている: ループをまたいで rl を使い回すと stdin が閉じない / 再入時にハングするバグを踏みやすく、HITL の頻度 (1 監査で 5〜10 回) なら毎回開き直しても体感差は無い
2. HITL ループ: `invoke → detect → resolve → invoke(Command({resume}))` を while で回す。**`MAX_HITL_ITERATIONS = 20` の安全装置**を置き、policy がバグで reject を連発して agent が無限に新しい interrupt を生み続けるような事故を早期に検出する
3. `thread_id` は `crypto.randomUUID()` で毎回新規発行。`Date.now()` は並行実行時の衝突リスクがあるので避ける。MemorySaver は thread 単位で state を分離するので、CLI 1 呼び出しが別の実行と干渉しない

**テスト戦略**: pure core はユニットテスト (`tests/hitl.test.ts`) で 23 ケース完全カバー。`scripts/run-audit.ts` の HITL ループは top-level await + `process.exit` を含むため**ユニットテストせず**、代わりに `--help` 実行を shell で 1 回叩いて import chain が壊れていないかだけ確認する (spec-001 で `runCli` を pure 分離したのと同じ戦略の再利用)。pure core が十分に縛られていれば、thin entry 側のループはコードレビューと目視で十分。

**`Decision.type` の narrowing**: `Decision` は `ApproveDecision | EditDecision | RejectDecision` の union で、`message` は `RejectDecision` だけが持つ。テストで `decision.message` を読むときは `if (decision.type === "reject")` で narrowing してからアクセスする必要がある。これを忘れると TS2339 "Property 'message' does not exist on type 'ApproveDecision'" で弾かれる。

**`noUncheckedIndexedAccess` と配列直アクセス**: 本プロジェクトの `tsconfig.json` は `noUncheckedIndexedAccess: true` で、`seen[0].actionName` のような直アクセスは `T | undefined` を返す。テストでは `const first = seen[0]; expect(first?.actionName)...` のように一度変数に取って optional chaining するか、明示的に `expect(first).toBeDefined()` してから `!` で non-null assertion する。配列 index が多いテストで踏みやすいので、vitest + `noUncheckedIndexedAccess` の組み合わせでは assertion helper を用意しておくと楽。

### HITL 配線 (checkpointer + interruptOn) のツール選定基準

spec-006 の最初のタスクで `createAuditAgent()` に `checkpointer` (`MemorySaver`) と `interruptOn` を追加した。v1.9 の `humanInTheLoopMiddleware` は **ツール名単位** で interrupt を発火するため、**引数 (パス) でフィルタできない**。この制約を知らずに `write_file` を interrupt 対象に入れると、各サブエージェントが `/raw/<aspect>/result.json` を書くたびに中断がかかり、監査が事実上進まなくなる。

判定基準:

1. **外部副作用を伴うツールだけを対象にする**: レート制限を消費したり、外部サービスに記録を残したりするツール (`fetch_github`, `query_osv`) が本命。built-in の `read_file` / `write_file` / `edit_file` は「内部的にスクラッチ領域に書く」用途でも大量に呼ばれるので、一律 interrupt 対象にすると機能しない
2. **"特定のパスだけ interrupt したい" は middleware ではなく orchestrator の責務に回す**: 最終レポート (`/reports/`) や長期メモリ (`/memories/`) への書き込みは、agent のツール呼び出しではなく orchestrator (CLI / `writeAuditReport` / memory helper) 経由で行う設計 (spec-004 / spec-005 で確立済み)。したがって HITL を効かせるべき層も orchestrator 側で、agent の `interruptOn` には入れない
3. **`interruptOn: {}` を渡すと実質 no-op** になる。HITL をテストで無効化したいときの escape hatch として使える (smoke test での `createAuditAgent({ interruptOn: {} })` 参照)

**v1.9 の API 名前付けに関する注意**: Python 版 deepagents / LangGraph の `InMemorySaver` は、TS 版では `MemorySaver` (from `@langchain/langgraph-checkpoint`) が正式名称。spec-006 の本文に書かれていた `InMemorySaver` は Python 版の表記で、TS 側の実装では **`MemorySaver` に読み替える**。spec-005 の `use_longterm_memory: true` と同じ「Python 由来の表記を v1.9 に合わせる」パターンの再発。

**`InterruptOnConfig` は `allowedDecisions` + `description` を明示する**:

\`\`\`ts
{
  allowedDecisions: ["approve", "reject"],  // "edit" を入れるなら argsSchema も必要
  description: "GitHub API 呼び出しは認証トークンのレート制限を消費します。実行を許可しますか?",
}
\`\`\`

- `true` のかわりに `InterruptOnConfig` を渡すと、human-facing なメッセージが **ツールごとに違う文言** になり、承認する人間が「何を承認しているか」を把握しやすい
- `allowedDecisions` に `"edit"` を入れると `argsSchema` (JSON Schema) が必要になる。今回は approve / reject の 2 択に絞ったので不要
- `description` は日本語で書く。smoke test で CJK 文字の混入を assert しておくと、将来英語で上書きされたときに気付ける

**`checkpointer` は `interruptOn` と不可分**: interrupt して resume するためには中断時点の state を保存する checkpointer が必須。両方を DI で optional 注入できるようにし、**デフォルトで常に配線しておく**のが安全 (`interruptOn: {}` で中断自体は止められるので、checkpointer のオーバーヘッドは許容)。`store` / `checkpointer` / `interruptOn` の 3 つの optional 注入口を同じ DI パターンに揃えることで、テストでは「HITL 無効化したいときだけ空オブジェクトを渡す」の 1 行で制御できる。

### `CompositeBackend` の prefix 配線を LLM なしで決定論的にテストする (legacy mode)

spec-005 で `/memories/` → `StoreBackend` の prefix ルーティングが本当に効いているかを検証したいが、`createAuditAgent({ store }).invoke(...)` は LLM 呼び出しを伴うので決定論的ではない。**`StoreBackend` / `StateBackend` の legacy mode** を使うと、LangGraph 実行コンテキスト (`getStore()`) なしでもテストから同じ配線を組める。

\`\`\`ts
import { CompositeBackend, StateBackend, StoreBackend } from "deepagents";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

const sharedStore = new InMemoryStore();
const stateAndStore = { state: {}, store: sharedStore };
const composite = new CompositeBackend(new StateBackend(stateAndStore), {
  "/memories/": new StoreBackend(stateAndStore),
});

await composite.read("/memories/audit-policy.json");  // ← 実コードと同じ経路
\`\`\`

ポイント:

1. **legacy mode の判定は `"state" in obj`**: `node_modules/deepagents/dist/index.js` line 4227-4238 / line 557-565 で確認できる通り、constructor は引数オブジェクトに `state` キーがあれば legacy mode と判定する。`state` の値自体は `StoreBackend` の中では **参照されない** (`getStore()` と `getNamespace()` だけが `stateAndStore` を読む) ため、空オブジェクト `{}` で十分
2. **helper の規約 ↔ deepagents の prefix 剥がし** が一致していることを直接実走させられる: helper で `store.put(["filesystem"], "/audit-policy.json", ...)` した値を `composite.read("/memories/audit-policy.json")` で読み戻せれば、namespace + key + FileData v2 形状のすべてが正しいことになる
3. **/memories/ 以外のパスは触らない**: default の StateBackend は zero-arg だと state-tracking が動かないが、テストで `/memories/...` 以外を読み書きしなければ問題ない (CompositeBackend は prefix にマッチしたパスだけを StoreBackend に流すので)

この「LLM 不要 + 配線証跡」テストパターンは、spec-006 (HITL) / spec-007 (Skills) / spec-008 (Middleware) でも応用可能。エージェントの非決定性を排除しつつ、**プロダクションコードと同じ実行経路** で配線を縛れるのが利点。

### 長期メモリレイヤを「型・パス・薄いラッパ」に分離する 3 ファイル構成

`policy.ts` / `preferences.ts` / `history.ts` の 3 ファイルはすべて以下の同型構造で書いている:

1. **下回りは `store-helpers.ts` の `readMemoryJson` / `writeMemoryJson`** に統一
2. 各ファイルは: ドメイン型 + canonical path 定数 + 薄い read/write ラッパ
3. 正規化が必要な場合 (`preferences.ts` の `normalizePriorityAspects` / `history.ts` の `slugifyAuditTarget`) はドメイン側に閉じる

このパターンの恩恵:

- **規約変更 (namespace, prefix, FileData 形状) は 1 ファイル** (`store-helpers.ts`) に局所化される
- 各ドメインのテストは「正規化と round-trip」だけに集中でき、prefix 剥がし規約のテストは `policy.test.ts` 1 箇所に集約 (preferences/history 側で再検証しない)
- 後で永続 BaseStore (SQLite 等) に差し替えるときも `store-helpers.ts` の `created_at` get→put race を直すだけで 3 ファイル分が片付く

**responsibility 境界の指針**: 「persist する責務」と「いつ persist するか決める責務」を分ける。helper は前者だけを担い、後者 (HITL での対話収集 / 監査完了後の history 書き込み) は後続 spec のオーケストレーション層に委ねる。spec-005 で helper を作ったときに **CLI から呼び出していない** ことに対するレビュー指摘があったが、これは**意図的なスコープ分離**で、helper を作っただけでは production パスから到達しなくて当然。spec の Implementation Steps が「ヘルパーを実装」と書いているなら helper まで、「フローを実装」と書いていれば呼び出し側まで作る、と粒度を読み替えるのが筋。

### Phase 番号付きプロンプトに段階を後から差し込むときの互換ルール

`AUDIT_SYSTEM_PROMPT` は spec-004 で「Phase 1 (監査) / Phase 2 (検証)」の 2 フェーズ構成にしたが、spec-005 で履歴参照を入れるために **Phase 0** を追加した。既存の smoke test が `indexOf("Phase 1") < indexOf("Phase 2")` を assert していたが、Phase 0 を Phase 1 の **前** に追加してもこの不等号は壊れず、互換性を保てた。

汎用ルール:

- **既存の段階名 (`Phase 1`, `Phase 2`...) は変えない**
- **追加段階は番号を飛ばさず、前後関係を indexOf 比較で固定**
- 新しく追加した段階の挙動 (履歴の存在を許容 / 書き込みは禁止 / 順序) はそれぞれ独立した assertion で固定する。1 つに詰め込むと将来の prompt 編集で壊れたときの原因切り分けが困難になる

`tests/smoke.test.ts` の Phase 0 アサーション 4 本 (Phase 番号 / 履歴 path / 「履歴が無くても続行」/「書き込みはエージェントの責務ではない」) はこの方針の実例。

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
- **SKILL.md の形式契約は audit / report で共通**: `skills/audit/*` と `skills/report/*` はカテゴリこそ違うが、同じ frontmatter 契約 (`name` = 親ディレクトリ名 / `description` 非空 / `allowed-tools` リスト) と同じ本体契約 (`# ` トップレベル見出し + 実質 200 文字超) を共有する。テストは `tests/skills-{audit,report}.test.ts` に分けているが、`parseFrontmatter` の行ベース実装は 2 ファイルに同一コピー。3 カテゴリ目が出てきたら `tests/_helpers/` に共通ヘルパを抽出するのが筋。配線タスクで deepagents の `validateSkillName` 相当チェックが動いても、この契約を守る限り落ちない前提で設計している。
- **Skills の供給方式は FilesystemBackend ルーティングに決定 (spec-007 設計決定)**: StateBackend 初期 state への files 注入 vs. FilesystemBackend ルーティングの 2 択で、後者を採用。理由 4 点: (1) 既存の `/memories/` → StoreBackend と同じ prefix ルーティングパターンで統一感が出る、(2) SKILL.md を pre-read して初期 state に流し込む async bootstrap が不要、(3) 段階的開示 (Progressive Disclosure) が backend 層で自然に効く (frontmatter だけ走査・本体はオンデマンド read)、(4) `virtualMode: true` が `..` / `~` の traversal を拒否するので agent が `skills/` 外へ抜け出せない安全網が入る。`CompositeBackend` は longest-prefix match + prefix ストリップを `dist/index.js` L5183 で行うため、`/skills/audit/license/SKILL.md` は FilesystemBackend 側では `/audit/license/SKILL.md` として届き、`rootDir` (リポジトリの `skills/`) 配下に解決される。実装は `src/agent.ts` の `DEFAULT_SKILLS_ROOT_DIR` + `DEFAULT_SKILL_SOURCES` + backend factory の 3-way 化 + `skillsRootDir`/`skills` DI。
- **`DEFAULT_SKILLS_ROOT_DIR` は cwd 非依存で解決する**: `import.meta.url` + `../skills` で `src/agent.ts` の位置から相対解決。vitest (`tests/` から起動) / `npx tsx scripts/run-audit.ts` (リポジトリ直下から起動) / 本番 `node` (任意 cwd) のいずれでも同じディレクトリを指す。`process.cwd()` を使うと CI や scripts/ 経由の呼び出しで破綻するので注意。
- **Skill 配線の粒度は 2 階層 (spec-007 最終)**: (1) **メインエージェント** = `/skills/audit/` + `/skills/report/` の 2 ソース (オーケストレータとして全観点 + 最終レポート文体を知る必要がある)、(2) **5 観測 subagent + critic** = `/skills/audit/` のみ (report 系は流れない)。subagent/main の主たる filter 境界は **"audit vs report"**。**当初は 3 階層** (観測 subagent は自観点 1 つだけ) を狙ったが、deepagents v1.9 の `listSkillsFromBackend` が **source パスの直下に存在するサブディレクトリを 1 階層だけ走査** し各サブディレクトリの `SKILL.md` を読む方式のため、`/skills/audit/license/` のように観点単独パスを指定すると中身は `SKILL.md` (ファイル) しかなく 0 skill しか返らない。回避には skills/ の物理レイアウト再構造化が必要で、スコープに見合わないため 2 階層で妥協した。**観点単位の実質的フィルタは LLM の description マッチ + 段階的開示本体 read** に委ねる (`tests/skills-progressive-disclosure.test.ts` に 0-skill ケースを回帰ガードとして固定済み)。deepagents v1.9 では custom subagent はメインの skills を継承しないので、各 factory が自力で `skills: [...]` を返す必要がある (general-purpose だけが継承する)。
- **`listSkillsFromBackend` の契約 (deepagents v1.9)**: source パス (末尾 `/`) の直下を `ls` し、**is_dir=true の entry に限って** `${entry}/SKILL.md` を読む。つまり (a) 直接のサブディレクトリしか見ない (再帰なし)、(b) 直下のファイルを無視する。したがって skill を段階的開示するには `skills/<category>/<skill-name>/SKILL.md` の 2 層レイアウトが必須で、カテゴリ内の個別 skill を絞るには物理的にサブディレクトリに分割するしかない。`dist/index.js` L2584 付近で確認。
- **langchain middleware の `wrapToolCall` 契約 (spec-008)**: `createMiddleware({ wrapToolCall: async (request, handler) => {...} })` で tool 実行を wrap できる。`request.toolCall.id` は **`string | undefined`** (実体は `@langchain/core/messages` の ToolCall 型、`id` optional) で `src/middleware/logging.ts` の実装時に narrow 必要。失敗時の契約は **try/catch で sink 記録 → rethrow** が基本。rethrow しないと agent 側に "成功したフリ" を見せることになる (langgraph のエラーパスに戻さないと tool_call が完了扱いされる)。pure event builder + sink DI + I/O ラッパ + middleware factory の 4 層分離 (`src/hitl-log.ts` と同パターン) にすると、middleware 本体の責務は「tool 呼び出しを try/catch で囲み sink を叩く」だけになり、テストは in-memory sink で決定論的に書ける。
- **Rate limit middleware は min-interval 方式で十分 (spec-008)**: GitHub API の真の quota を header から読む実装は (1) tool の戻り値を headers 付きで拡張する / (2) client 層に observability を追加する の 2 択で、spec-008 のスコープを超える。代わりに **最小呼び出し間隔 (min-interval)** を強制する方式なら `lastStartAt + minIntervalMs - now` の pure 計算だけで実装でき、deepagents の tool wrap インターフェースからはみ出さない。`DEFAULT_GITHUB_MIN_INTERVAL_MS=700` は GitHub authenticated 5000/hour = 1.388 req/sec から逆算した安全寄りの値で、fetch_github の実遅延を含めて実効 1 req/sec 付近に収まる想定。clock skew (now < lastStartAt) は `minIntervalMs` にクランプして無限待ちを防ぐこと。並列 tool_call への race は "serial 前提" として文書化に留め、mutex は入れない (spec-006 HITL と組み合わせると実質 serial に強制される)。`now` と `sleep` を DI にすれば test は実時間ゼロで決定論化できる。

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
