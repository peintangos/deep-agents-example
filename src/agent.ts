import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  createDeepAgent,
  CompositeBackend,
  StateBackend,
  StoreBackend,
} from "deepagents";
import type { InterruptOnConfig } from "langchain";
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
}

export function createAuditAgent(options: CreateAuditAgentOptions = {}) {
  const store = options.store ?? new InMemoryStore();
  const checkpointer = options.checkpointer ?? new MemorySaver();
  const interruptOn = options.interruptOn ?? DEFAULT_INTERRUPT_ON;
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
     * `/memories/` 配下はセッション横断で永続化したいので StoreBackend に、
     * それ以外のすべてのパス (`/raw/`, `/reports/`, `/` 直下の transient データ等) は
     * deepagents のデフォルト同様 StateBackend (ephemeral) に振り分ける。
     *
     * これが spec-005 のコア配線。`CompositeBackend` の prefix ルーティング経由で
     * サブエージェントは `write_file("/memories/audit-policy.json", ...)` のような
     * 既存の built-in ツールを使うだけで長期メモリにアクセスできる。
     */
    backend: (config) =>
      new CompositeBackend(new StateBackend(config), {
        "/memories/": new StoreBackend(),
      }),
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
  });
}
