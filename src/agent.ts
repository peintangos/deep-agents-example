import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  createDeepAgent,
  CompositeBackend,
  StateBackend,
  StoreBackend,
} from "deepagents";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
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
}

export function createAuditAgent(options: CreateAuditAgentOptions = {}) {
  const store = options.store ?? new InMemoryStore();
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
  });
}
