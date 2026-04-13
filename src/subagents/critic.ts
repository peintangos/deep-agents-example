import type { SubAgent } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import { rawPath } from "../fs-layout";

export interface CriticOptions {
  /**
   * サブエージェントに注入する追加ツール。
   *
   * critic は独自ツールを必要としない (5 観点の raw データは deepagents の default
   * `read_file` で読み、findings は `write_file` で書く)。options を受け取る形は
   * あくまで他の factory とのインターフェース統一 + 将来の拡張余地のため。
   *
   * 指定されなかった場合は `tools` を設定せず、deepagents の default tools
   * (`read_file` / `write_file` / `edit_file` など) に委ねる。
   */
  readonly tools?: readonly StructuredTool[];
}

/**
 * 監査結果の整合性検証に特化した critic サブエージェント。
 *
 * 責務:
 *   - 5 観点のサブエージェントが書き出した raw データを読み込む
 *   - 観点間の矛盾 / 不足 / ファクトエラーを検出する
 *   - 検出結果を `/raw/critic/findings.json` に構造化して書き出す
 *
 * このサブエージェントは fetch 系ツールを持たない。外部世界に問い合わせず、
 * 仮想 FS 上の raw データだけを材料に判定する純粋な検証器として振る舞う。
 */
export function createCriticSubAgent(options: CriticOptions = {}): SubAgent {
  const outputPath = rawPath("critic", "findings.json");
  const inputs = {
    license: rawPath("license", "result.json"),
    security: rawPath("security", "result.json"),
    maintenance: rawPath("maintenance", "result.json"),
    apiStability: rawPath("api-stability", "result.json"),
    community: rawPath("community", "result.json"),
  };

  const agent: SubAgent = {
    name: "critic",
    description:
      "5 観点の監査結果を読み込み、観点間の矛盾・不足・ファクトエラーを検出する整合性検証サブエージェント。監査フェーズ終了後にメインエージェントが呼び出す。",
    systemPrompt: `あなたは監査結果の整合性を検証する critic サブエージェントです。

ミッション:
1. 5 観点の raw データを read_file で読み込む:
   - ライセンス: ${inputs.license}
   - セキュリティ: ${inputs.security}
   - メンテナンス健全性: ${inputs.maintenance}
   - API 安定性: ${inputs.apiStability}
   - コミュニティ採用状況: ${inputs.community}
2. 観点間の矛盾 (複数の raw データが互いに両立しない主張をしているケース) を検出する
3. 明らかに不十分な記述 (根拠欠落 / unknown の連発 / フィールド欠落) を検出する
4. 検出結果を ${outputPath} に JSON として write_file で書き出す

出力フォーマット:
{
  "findings": [
    {
      "severity": "critical" | "warning" | "info",
      "aspect": "license" | "security" | "maintenance" | "api-stability" | "community" | "cross-aspect",
      "message": "何が問題か (一文で)",
      "evidence": "根拠となった raw データのフィールド名や値"
    }
  ],
  "overall_assessment": "pass" | "warnings" | "blocked"
}

overall_assessment の判定基準:
- critical が 1 件以上: "blocked"
- warning のみ: "warnings"
- info 以下のみ (または findings 空): "pass"

利用可能なツール:
- read_file(path): 5 観点の raw データを読み込む
- write_file(path, content): ${outputPath} に findings JSON を書き出す

原則:
- ファクト重視。raw データに無い事実は捏造しない
- 各観点の raw データが未生成 / 読み込めない場合は、それ自体を findings として記録する (再実行はしない)
- "矛盾" とは 2 つ以上の raw データが両立不能な主張をしている場合に限定する (1 観点内の単なる不足は "不十分" として分類する)
- 推測や主観評価は書かない`,
  };

  if (options.tools) {
    agent.tools = [...options.tools] as StructuredTool[];
  }

  return agent;
}
