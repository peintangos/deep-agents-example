import type { SubAgent } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import { rawPath } from "../fs-layout";

/**
 * critic サブエージェントに流す skill ソースのデフォルト。
 *
 * critic の責務は 5 観点の raw データを横断で読み、観点間の矛盾・不足・ファクト
 * エラーを検出することにある。そのため **5 観点のすべての SKILL.md を読める
 * 必要がある** (どの観点が何を判定するかを理解しないと、findings の根拠が浅く
 * なる)。他のサブエージェントは自観点だけの 1 ソースだが、critic は例外的に
 * `/skills/audit/` 直下のすべてを scan する広いソース指定を使う。
 *
 * これは spec-007 の acceptance criterion "サブエージェントが独自の Skills を
 * 持てる" を満たすための典型例: メイン agent は audit + report の 2 ソース、
 * critic は audit のみの 1 ソース、license-analyzer 等は audit/<aspect> の
 * ピンポイント 1 ソース、と粒度が 3 階層に分かれる。
 */
export const DEFAULT_CRITIC_SKILLS: readonly string[] = [
  "/skills/audit/",
] as const;

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

  /**
   * critic に流す skill ソースのリスト (仮想パス)。
   * 省略時は {@link DEFAULT_CRITIC_SKILLS} (`/skills/audit/` 全体)。
   */
  readonly skills?: readonly string[];
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

  const skills = options.skills ?? DEFAULT_CRITIC_SKILLS;

  const agent: SubAgent = {
    name: "critic",
    description:
      "5 観点の監査結果を読み込み、観点間の矛盾・不足・ファクトエラーを検出する整合性検証サブエージェント。監査フェーズ終了後にメインエージェントが呼び出す。",
    skills: [...skills],
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
