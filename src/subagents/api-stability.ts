import type { SubAgent } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import { createFetchGithubTool } from "../tools/fetch-github";
import { rawPath } from "../fs-layout";

/**
 * api-stability サブエージェントに流す skill ソースのデフォルト。
 * 詳細は license-analyzer.ts の解説参照。
 */
export const DEFAULT_API_STABILITY_SKILLS: readonly string[] = [
  "/skills/audit/api-stability/",
] as const;

export interface ApiStabilityOptions {
  readonly tools?: readonly StructuredTool[];
  /**
   * このサブエージェントに流す skill ソースのリスト (仮想パス)。
   * 省略時は {@link DEFAULT_API_STABILITY_SKILLS}。
   */
  readonly skills?: readonly string[];
}

/**
 * API 安定性に特化したサブエージェントの仕様を構築する。
 *
 * 責務:
 *   - リリース履歴を確認し、メジャーバージョン更新の頻度を把握する
 *   - breaking change の記述 (CHANGELOG / リリースノート) を探す
 *   - SemVer 遵守度を推定する
 *   - 結果を `/raw/api-stability/result.json` に構造化して書き出す
 */
export function createApiStabilitySubAgent(
  options: ApiStabilityOptions = {},
): SubAgent {
  const tools = [...(options.tools ?? [createFetchGithubTool()])];
  const skills = options.skills ?? DEFAULT_API_STABILITY_SKILLS;
  const outputPath = rawPath("api-stability", "result.json");

  return {
    name: "api-stability",
    description:
      "OSS の API 安定性 (breaking change 頻度 / SemVer 遵守度) を評価する。API 安定性観点での監査が必要な場合に委譲する。",
    skills: [...skills],
    systemPrompt: `あなたは OSS の API 安定性 (SemVer 遵守度) を評価するサブエージェントです。

ミッション:
1. 対象 OSS のリポジトリメタデータを取得し、default_branch と description を確認する
2. 公開されているリリースやタグの情報 (取得できる範囲) から、メジャーバージョン更新頻度と SemVer 遵守を推定する
3. プロジェクトの成熟度 (作成日 / 現在バージョン) を総合評価する
4. 結果を ${outputPath} に JSON として書き出す

出力フォーマット:
{
  "stability_level": "stable" | "maturing" | "unstable" | "unknown",
  "default_branch": "main",
  "created_at": "...",
  "age_in_days": 0,
  "breaking_change_signals": ["..."],
  "notes": "根拠 (取得できたメタデータの範囲を明示)"
}

判定目安:
- stable: age > 2 年 かつ breaking change の言及が少ない
- maturing: age 6 ヶ月〜2 年、または最近の大幅更新あり
- unstable: age < 6 ヶ月、または現 default branch が頻繁に breaking change を含む
- unknown: メタデータ不足で判定できない

利用可能なツール:
- fetch_github(owner, repo): GitHub のリポジトリメタデータ取得
- write_file(path, content): 結果を仮想 FS に保存 (${outputPath})
- read_file(path): 既存の raw データ参照

原則:
- 取得できたメタデータに書いてある事実だけを使う
- 現時点では GitHub API の基本メタデータしか触れないため、リリース履歴の詳細は後続 spec で拡張する前提でよい
- 不明点は "unknown" と明示し、判定根拠を notes に書く`,
    tools: tools as StructuredTool[],
  };
}
