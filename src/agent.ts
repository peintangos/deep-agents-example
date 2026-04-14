import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  createDeepAgent,
  CompositeBackend,
  FilesystemBackend,
  StateBackend,
  StoreBackend,
} from "deepagents";
import type { AgentMiddleware, InterruptOnConfig } from "langchain";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph-checkpoint";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import { createLicenseAnalyzerSubAgent } from "./subagents/license-analyzer";
import { createSecurityAuditorSubAgent } from "./subagents/security-auditor";
import { createMaintenanceHealthSubAgent } from "./subagents/maintenance-health";
import { createApiStabilitySubAgent } from "./subagents/api-stability";
import { createCommunityAdoptionSubAgent } from "./subagents/community-adoption";
import { createCriticSubAgent } from "./subagents/critic";
import {
  createToolCallLoggingMiddleware,
  createFileToolCallLogSink,
  type ToolCallLogSink,
} from "./middleware/logging";
import {
  createGithubRateLimitMiddleware,
  type GithubRateLimitMiddlewareOptions,
} from "./middleware/rate-limit";
import { createValidateToolArgsMiddleware } from "./middleware/validate";

/**
 * OpenRouter 経由で利用するモデル名。
 * OpenRouter は OpenAI 互換 API のアグリゲータで、ベンダーを切り替えやすくするために採用。
 */
export const DEFAULT_MODEL_NAME = "openai/gpt-4.1" as const;

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1" as const;

export const AUDIT_SYSTEM_PROMPT = `あなたは OSS プロジェクトを多観点で監査するオーケストレーターです。

## 過去履歴の参照 (Phase 0)

監査開始前に、対象 OSS の過去履歴が \`/memories/history/\` 配下に存在しないか
read_file で確認してください。命名規約は
\`/memories/history/<owner>-<repo>-<yyyy-mm>.json\` (例:
\`/memories/history/mastra-ai-mastra-2026-03.json\`) です。前月分が存在すれば
読み取り、現在の監査結果との差分を critic フェーズで踏まえられるようにします。

履歴ファイルが存在しなくても監査は通常通り続行してください。**履歴ファイルへの
書き込みはエージェントの責務ではありません** (オーケストレーション層が監査完了後
に行います)。Phase 0 は読み取りのみで完結させてください。

## 監査フェーズ (Phase 1)

以下の 5 観点について、対応するサブエージェントに task で委譲してください。
可能な範囲で並列に委譲して構いません。各サブエージェントは自分の担当パスに
raw データを書き出します。

- ライセンス            → license-analyzer  (/raw/license/result.json)
- セキュリティ          → security-auditor  (/raw/security/result.json)
- メンテナンス健全性    → maintenance-health (/raw/maintenance/result.json)
- API 安定性            → api-stability     (/raw/api-stability/result.json)
- コミュニティ採用状況  → community-adoption (/raw/community/result.json)

## 検証フェーズ (Phase 2)

5 観点の raw データがすべて書き出された後、critic サブエージェントに task で
委譲してください。critic は観点間の矛盾 / 不足 / ファクトエラーを検出して
/raw/critic/findings.json に findings を書き出します。Phase 1 が終わる前に
critic を呼んではいけません。

## 完了条件

以下 6 ファイルが仮想 FS に揃った時点で、本エージェントの役割は終わりです。

- /raw/license/result.json
- /raw/security/result.json
- /raw/maintenance/result.json
- /raw/api-stability/result.json
- /raw/community/result.json
- /raw/critic/findings.json

最終的な Markdown レポートへの統合はオーケストレーション層 (src/reporter.ts)
が raw データを読み込んで実行するため、本エージェント自身は Markdown を
組み立てません。完了時は短く "監査完了" と返せば十分です。

## 原則

- ファクト重視、推測禁止。不明点はサブエージェントが "unknown" としてマークします
- 同じサブエージェントを短時間に何度も呼び直さない (raw データが既に書き出されているはず)
- サブエージェントの出力フォーマット (JSON Schema) を尊重し、こちらで再解釈しない`;

/**
 * ChatOpenAI インスタンスを生成する。OpenRouter の baseURL を指定することで、
 * OpenAI 互換のエンドポイントに統一しつつ任意のベンダーモデル (今回は `openai/gpt-4.1`)
 * を呼び出せるようにしている。
 *
 * TS2589 対策: `createDeepAgent` のジェネリックが深いため、`BaseChatModel` に
 * 明示キャストしてから渡すことで Runnable 型の無限展開を回避する。
 */
export function createLlm(): BaseChatModel {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.startsWith("<")) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Copy .env.example to .env and paste your OpenRouter API key.",
    );
  }
  return new ChatOpenAI({
    apiKey,
    model: DEFAULT_MODEL_NAME,
    configuration: {
      baseURL: OPENROUTER_BASE_URL,
    },
  }) as unknown as BaseChatModel;
}

/**
 * HITL (Human-in-the-Loop) 承認対象のツール。
 *
 * deepagents / langchain の `humanInTheLoopMiddleware` は `interruptOn` に
 * 書かれたツール名に一致する tool call を実行前に中断し、人間の承認を待つ。
 * ここでは **外部 API を叩くツール 2 つだけ** を対象にしている:
 *
 *   - `fetch_github`: GitHub API を叩くとレート制限を消費する
 *   - `query_osv`: OSV 脆弱性 DB への問い合わせ
 *
 * built-in の `write_file` は対象に入れない: agent は `/raw/<aspect>/result.json`
 * にも `write_file` で書き込むため、write_file 全てを中断すると監査が進まなくなる。
 * 仕様で言及された「最終レポート書き込み」「`/memories/` 書き込み」は
 * オーケストレーション層 (CLI / reporter / memory helper) の責務であり、agent の
 * tool としては発火しないので interruptOn で絡める必要がない (spec-005 の責務境界と
 * 同じ方針)。
 */
/**
 * 仮想 `/skills/` ネームスペースのルートになる実ファイルシステムディレクトリ。
 *
 * `src/agent.ts` からの相対位置で `../skills` を指しているので、vitest / `npx tsx` /
 * 本番 `node` 実行のいずれでも `import.meta.url` から同じリポジトリ直下の
 * `skills/` ディレクトリに解決される。cwd に依存しない点が重要 (CI や
 * `scripts/run-audit.ts` から呼ばれても壊れない)。
 */
export const DEFAULT_SKILLS_ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
);

/**
 * SkillsMiddleware に渡すデフォルトの skill ソース (仮想パス)。
 *
 * CompositeBackend で `/skills/` は FilesystemBackend にルーティングされるため、
 * ここに書くのは「prefix 込みの仮想パス」であって実ファイルパスではない。
 * 実ファイルは `DEFAULT_SKILLS_ROOT_DIR/audit/<aspect>/SKILL.md` /
 * `DEFAULT_SKILLS_ROOT_DIR/report/<style>/SKILL.md` に配置されている。
 *
 * SkillsMiddleware は列挙された各ソース配下を走査して SKILL.md を見つけ、
 * frontmatter (`name` / `description`) をシステムプロンプトに注入する。本体の
 * Markdown は段階的開示 (Progressive Disclosure) により、エージェントが必要と
 * 判断したタイミングでのみ読み込まれる。
 */
export const DEFAULT_SKILL_SOURCES: readonly string[] = [
  "/skills/audit/",
  "/skills/report/",
] as const;

/**
 * ツール呼び出し構造化ログの既定出力先 (spec-008)。
 *
 * spec-008 の Acceptance Criteria が指定するパス。`createAuditAgent` の
 * default middleware が ToolCallLoggingMiddleware をこのパスに向ける。
 * テストでは `middleware: []` や `middleware: createDefaultAuditMiddlewares(...)`
 * + in-memory sink を渡して上書きできる。
 */
export const DEFAULT_TOOL_CALL_LOG_PATH = "out/.state/tool-calls.jsonl" as const;

export interface CreateDefaultAuditMiddlewaresOptions {
  /**
   * ToolCallLoggingMiddleware が流す先の sink。省略時は
   * {@link DEFAULT_TOOL_CALL_LOG_PATH} に書き込む file sink。テストでは
   * in-memory sink (配列に push するだけ) を渡すと I/O ゼロで決定論化できる。
   */
  readonly toolCallLogSink?: ToolCallLogSink;
  /**
   * ToolCallLoggingMiddleware の file sink を作るときのパスを上書きする。
   * `toolCallLogSink` が明示的に渡されている場合は無視される。
   */
  readonly toolCallLogPath?: string;
  /**
   * GithubRateLimitMiddleware に渡す追加オプション。`minIntervalMs` / `toolNames` /
   * `now` / `sleep` をそのまま流す。テストでは `sleep` mock を差し込んで実時間
   * ゼロでスロットル挙動を検証する。
   */
  readonly rateLimit?: GithubRateLimitMiddlewareOptions;
}

/**
 * `createAuditAgent` のデフォルト middleware スタックを組み立てる。
 *
 * **順序**: `[logging, validate, rate-limit]`
 *
 * langchain の `utils.js` の `chainToolCallHandlers` は `middleware[0]` を
 * **outermost** として合成する (L315 の `for (let i = length-2; i >= 0; i--)`)。
 * つまりこの配列の左から右が「外 → 内」の順になる。
 *
 *   1. **logging (outermost)**: tool 呼び出しのあらゆる試行 (成功 / エラー /
 *      validation rejection) を全部記録する。rejection は `[validate]` を含む
 *      resultPreview として success event に現れる。
 *   2. **validate (middle)**: 不正引数を rate-limit の sleep が走る前に弾く。
 *      rejection 時は handler を呼ばずに `ToolMessage` を返すので、logging は
 *      それを一つの結果として記録するが rate-limit は起動しない。
 *   3. **rate-limit (innermost)**: validate を通った呼び出しにだけスロットルを
 *      かける。`lastStartAt` が不正呼び出しで進まないので、後続の有効な
 *      呼び出しへの遅延が無駄に長くなることも無い。
 *
 * 順序を入れ替えると意味が変わる:
 *   - logging を最内にすると validation rejection がログに出ない
 *   - validate を最内にすると rate-limit が不正呼び出しでも sleep を挿入する
 *   - rate-limit を logging より外にすると sleep 時間が logging の `durationMs`
 *     に混入する (本物の tool 実行時間と区別がつかなくなる)
 */
export function createDefaultAuditMiddlewares(
  options: CreateDefaultAuditMiddlewaresOptions = {},
): readonly AgentMiddleware[] {
  const sink =
    options.toolCallLogSink ??
    createFileToolCallLogSink(
      options.toolCallLogPath ?? DEFAULT_TOOL_CALL_LOG_PATH,
    );
  return [
    createToolCallLoggingMiddleware({ sink }),
    createValidateToolArgsMiddleware(),
    createGithubRateLimitMiddleware(options.rateLimit ?? {}),
  ];
}

export const DEFAULT_INTERRUPT_ON: Record<string, InterruptOnConfig> = {
  fetch_github: {
    allowedDecisions: ["approve", "reject"],
    description:
      "GitHub API 呼び出しは認証トークンのレート制限を消費します。実行を許可しますか?",
  },
  query_osv: {
    allowedDecisions: ["approve", "reject"],
    description:
      "OSV 脆弱性データベースへの問い合わせです。実行を許可しますか?",
  },
};

/**
 * `createAuditAgent` へのオプション。
 */
export interface CreateAuditAgentOptions {
  /**
   * 長期メモリの永続化に使う LangGraph Store。
   *
   * deepagents は `/memories/` プレフィックスを {@link StoreBackend} に
   * ルーティングすることで、セッションをまたいで値を保持する。ここに渡した
   * `BaseStore` インスタンスが deepagents の実行コンテキスト経由で
   * StoreBackend から参照される。
   *
   * 省略時はプロセスローカルな `InMemoryStore` が 1 エージェント 1 インスタンスで
   * 作られる (プロセスが終わると消える)。同じプロセス内で複数の
   * `createAuditAgent` 呼び出しに**跨いで** `/memories/` を共有したい場合は、
   * 呼び出し側で `new InMemoryStore()` を 1 つ作って両方に渡すこと。
   *
   * プロダクションで永続化したい場合は SQLite / Postgres などディスク裏打ちの
   * `BaseStore` 実装を差し替える想定。
   */
  readonly store?: BaseStore;

  /**
   * LangGraph の checkpointer。HITL で interrupt → resume するためには
   * checkpointer が必須 (中断時点の state を保存するのに使う)。
   *
   * 省略時はプロセスローカルな `MemorySaver` が自動生成される。プロダクションで
   * 永続化したい場合は SQLite / Postgres などディスク裏打ちの
   * `BaseCheckpointSaver` 実装に差し替える想定。`store` と同じ DI パターンに
   * 揃えてあるため、テストでは明示的に `new MemorySaver()` を渡して分離できる。
   */
  readonly checkpointer?: BaseCheckpointSaver;

  /**
   * HITL で承認を要求するツール設定。キーはツール名、値は
   * `langchain` の `InterruptOnConfig` (承認可能な判断の種類 / 説明文など)。
   *
   * 省略時は {@link DEFAULT_INTERRUPT_ON} (fetch_github + query_osv) が適用される。
   * 空オブジェクト `{}` を渡すと全ツール auto-approve になる (=実質 HITL 無効化)
   * ため、HITL を使わないテストでは `{}` を明示することで checkpointer 配線だけを
   * 検証できる。
   */
  readonly interruptOn?: Record<string, InterruptOnConfig>;

  /**
   * 仮想 `/skills/` ネームスペースの物理ルート。
   *
   * 省略時は {@link DEFAULT_SKILLS_ROOT_DIR} (リポジトリ直下 `skills/`)。
   * テストでは `tmpdir` に制御された SKILL.md を配置してから渡すことで、
   * 本物の `skills/` 配下に干渉せず「特定 skill だけ読み込まれる」ような
   * 段階的開示の検証ができる。
   *
   * `FilesystemBackend({ virtualMode: true })` 経由で `..` / `~` による
   * traversal は内部的に拒否されるため、agent 側から `skillsRootDir` 外の
   * ファイルにはアクセスできない。
   */
  readonly skillsRootDir?: string;

  /**
   * SkillsMiddleware が読み込む skill ソースの仮想パスリスト。
   *
   * 省略時は {@link DEFAULT_SKILL_SOURCES} (`["/skills/audit/", "/skills/report/"]`)。
   * 空配列 `[]` を渡すと skills middleware は何も読み込まず、実質 skill 無効化
   * のまま agent を構成できる (skills 機能を切った状態でのテスト向け)。
   *
   * サブエージェントごとに異なる skill セットを割り当てる配線は、サブエージェント
   * factory 側の `skills` フィールドで別途行う。ここで指定するのは
   * **メインエージェントに見える skill ソース** のみで、サブエージェントには
   * 自動伝搬しない (deepagents v1.9 では `general-purpose` サブエージェントだけが
   * メインの skills を継承する仕様)。
   */
  readonly skills?: readonly string[];

  /**
   * spec-008 の middleware スタック。tool 呼び出しに対する logging / validate /
   * rate-limit の 3 つを束ねたもの。
   *
   * 省略時は {@link createDefaultAuditMiddlewares} が返す `[logging, validate,
   * rate-limit]` の 3 本構成。logging は {@link DEFAULT_TOOL_CALL_LOG_PATH} に
   * file sink で書き込む。
   *
   * 空配列 `[]` を渡すと middleware を一切付与しない (ユニットテストや HITL
   * のみをテストしたいときに使える逃し弁)。部分的に差し替えたい場合は
   * `createDefaultAuditMiddlewares({ toolCallLogSink, rateLimit })` を呼んで
   * その戻り値を渡すのが推奨。任意の middleware 順序で自力組立も可能。
   *
   * 順序のセマンティクスは `createDefaultAuditMiddlewares` の JSDoc を参照。
   */
  readonly middleware?: readonly AgentMiddleware[];
}

export function createAuditAgent(options: CreateAuditAgentOptions = {}) {
  const store = options.store ?? new InMemoryStore();
  const checkpointer = options.checkpointer ?? new MemorySaver();
  const interruptOn = options.interruptOn ?? DEFAULT_INTERRUPT_ON;
  const skillsRootDir = options.skillsRootDir ?? DEFAULT_SKILLS_ROOT_DIR;
  const skills = options.skills ?? DEFAULT_SKILL_SOURCES;
  const middleware = options.middleware ?? createDefaultAuditMiddlewares();
  return createDeepAgent({
    model: createLlm(),
    systemPrompt: AUDIT_SYSTEM_PROMPT,
    subagents: [
      createLicenseAnalyzerSubAgent(),
      createSecurityAuditorSubAgent(),
      createMaintenanceHealthSubAgent(),
      createApiStabilitySubAgent(),
      createCommunityAdoptionSubAgent(),
      createCriticSubAgent(),
    ],
    store,
    /**
     * 3-way の CompositeBackend ルーティング:
     *
     *   - `/memories/` → StoreBackend   : セッション横断の永続化 (spec-005)
     *   - `/skills/`   → FilesystemBackend(virtualMode)
     *                                   : リポジトリ直下 `skills/` 配下の
     *                                     SKILL.md を段階的開示で読み込む (spec-007)
     *   - その他       → StateBackend   : `/raw/`, `/reports/`, transient 等
     *
     * `CompositeBackend` は longest-prefix match でルーティングし、prefix を
     * ストリップしてから下位 backend に渡す (dist/index.js L5183)。
     * したがって SkillsMiddleware が `/skills/audit/license/SKILL.md` を読むとき、
     * FilesystemBackend 側には `/audit/license/SKILL.md` として渡り、
     * `skillsRootDir` 配下の実ファイルに解決される。
     *
     * `FilesystemBackend({ virtualMode: true })` は traversal (`..` / `~`) を
     * 拒否するので、agent が `/skills/../` のような形で外に抜け出すことはできない。
     */
    backend: (config) =>
      new CompositeBackend(new StateBackend(config), {
        "/memories/": new StoreBackend(),
        "/skills/": new FilesystemBackend({
          rootDir: skillsRootDir,
          virtualMode: true,
        }),
      }),
    /**
     * SkillsMiddleware に渡すソース (仮想パス) のリスト。
     * 上記 backend と組み合わさって、FilesystemBackend 経由でディスク上の
     * SKILL.md が読み込まれる。frontmatter だけをシステムプロンプトに
     * 注入し、本体 Markdown は agent がタスクで必要としたときだけ read される
     * (Progressive Disclosure)。
     *
     * 注意: deepagents v1.9 の仕様では、ここで指定した skills が自動で
     * サブエージェントに継承されるのは `general-purpose` のみ。本プロジェクトの
     * 5 観点 + critic の custom subagent は継承されないため、次タスクで
     * 各 subagent factory の `skills` フィールドに個別割当する。
     */
    skills: [...skills],
    /**
     * HITL (spec-006) のために checkpointer と interruptOn を配線する。
     * interruptOn に指定したツール名の tool call が発生すると、deepagents は
     * `humanInTheLoopMiddleware` 経由で実行を中断し、呼び出し元に
     * `result.__interrupt__` を返す。呼び出し側は `Command({ resume })` で
     * 承認・却下を返すことで実行を再開できる。
     *
     * checkpointer が無いと interrupt 前後で state を保てないので、interruptOn を
     * 使うなら checkpointer は必須。両方をここで常に渡しているのは、将来 HITL を
     * 無効化したいときでも `interruptOn: {}` を渡せば実質 no-op になり、配線を
     * 削る必要が無いため (checkpointer 自体のオーバーヘッドは無視できる)。
     */
    checkpointer,
    interruptOn,
    /**
     * spec-008 middleware スタック。default は
     * `[logging, validate, rate-limit]` の 3 本で、langchain の
     * `chainToolCallHandlers` が左から右に向けて "外 → 内" の順で合成する。
     * 順序の根拠と入れ替え時の意味変化は `createDefaultAuditMiddlewares` の
     * JSDoc を参照すること。
     *
     * middleware の戻り型 (langchain の AgentMiddleware) は `readonly` を
     * 直接は受け付けないため、mutable な配列にコピーしてから渡す。元の配列を
     * ここで変更しないので不変性は保たれる。
     */
    middleware: [...middleware],
  });
}
