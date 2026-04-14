import type { SubAgent } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import { createFetchGithubTool } from "../tools/fetch-github";
import { rawPath } from "../fs-layout";

/**
 * community-adoption サブエージェントに流す skill ソースのデフォルト。
 * 詳細は license-analyzer.ts の解説参照。
 */
export const DEFAULT_COMMUNITY_ADOPTION_SKILLS: readonly string[] = [
  "/skills/audit/community/",
] as const;

export interface CommunityAdoptionOptions {
  readonly tools?: readonly StructuredTool[];
  /**
   * このサブエージェントに流す skill ソースのリスト (仮想パス)。
   * 省略時は {@link DEFAULT_COMMUNITY_ADOPTION_SKILLS}。
   */
  readonly skills?: readonly string[];
}

/**
 * コミュニティ採用状況に特化したサブエージェントの仕様を構築する。
 *
 * 責務:
 *   - GitHub stars / forks / open issues を指標として集める
 *   - description とトピックから community の位置づけを把握する
 *   - 結果を `/raw/community/result.json` に構造化して書き出す
 */
export function createCommunityAdoptionSubAgent(
  options: CommunityAdoptionOptions = {},
): SubAgent {
  const tools = [...(options.tools ?? [createFetchGithubTool()])];
  const skills = options.skills ?? DEFAULT_COMMUNITY_ADOPTION_SKILLS;
  const outputPath = rawPath("community", "result.json");

  return {
    name: "community-adoption",
    description:
      "OSS のコミュニティ採用状況 (stars / forks / dependents / 実運用事例) を評価する。コミュニティ観点での監査が必要な場合に委譲する。",
    skills: [...skills],
    systemPrompt: `あなたは OSS のコミュニティ採用状況を評価するサブエージェントです。

ミッション:
1. 対象 OSS の stargazers_count / forks_count / open_issues_count を取得する
2. description から目的とターゲット (フレームワーク / ライブラリ / ツール) を判別する
3. stars / forks の比率から活発な採用度合いを推定する
4. 結果を ${outputPath} に JSON として書き出す

出力フォーマット:
{
  "stars": 0,
  "forks": 0,
  "fork_to_star_ratio": 0.0,
  "open_issues": 0,
  "description": "...",
  "adoption_tier": "niche" | "rising" | "popular" | "mainstream" | "unknown",
  "notes": "判定の根拠となった具体的な数値"
}

判定目安 (stars ベース):
- niche: < 1,000
- rising: 1,000〜10,000
- popular: 10,000〜50,000
- mainstream: 50,000+

利用可能なツール:
- fetch_github(owner, repo): GitHub のリポジトリメタデータ取得
- write_file(path, content): 結果を仮想 FS に保存 (${outputPath})
- read_file(path): 既存の raw データ参照

原則:
- stars / forks は取得時点のスナップショット。推測は含めない
- dependents / npm download 数など GitHub メタデータ外の指標は後続 spec で拡張する前提でよい
- 不明点は "unknown" と明示する`,
    tools: tools as StructuredTool[],
  };
}
