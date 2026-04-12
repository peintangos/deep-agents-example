import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createDeepAgent } from "deepagents";
import { createLicenseAnalyzerSubAgent } from "./subagents/license-analyzer";

/**
 * OpenRouter 経由で利用するモデル名。
 * OpenRouter は OpenAI 互換 API のアグリゲータで、ベンダーを切り替えやすくするために採用。
 */
export const DEFAULT_MODEL_NAME = "openai/gpt-4.1" as const;

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1" as const;

export const AUDIT_SYSTEM_PROMPT = `あなたは OSS プロジェクトを多観点で監査するアシスタントです。
ライセンス / セキュリティ / メンテナンス健全性 / API 安定性 / コミュニティ採用状況 の 5 観点を
調査して、客観的な根拠に基づいた監査レポートを生成します。`;

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

export function createAuditAgent() {
  return createDeepAgent({
    model: createLlm(),
    systemPrompt: AUDIT_SYSTEM_PROMPT,
    subagents: [createLicenseAnalyzerSubAgent()],
  });
}
