import { createDeepAgent } from "deepagents";

export const DEFAULT_MODEL = "claude-sonnet-4-5-20250929" as const;

export const AUDIT_SYSTEM_PROMPT = `あなたは OSS プロジェクトを多観点で監査するアシスタントです。
ライセンス / セキュリティ / メンテナンス健全性 / API 安定性 / コミュニティ採用状況 の 5 観点を
調査して、客観的な根拠に基づいた監査レポートを生成します。`;

export function createAuditAgent() {
  return createDeepAgent({
    model: DEFAULT_MODEL,
    systemPrompt: AUDIT_SYSTEM_PROMPT,
  });
}
