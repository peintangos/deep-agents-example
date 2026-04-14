import type { SubAgent } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import { createFetchGithubTool } from "../tools/fetch-github";
import { rawPath } from "../fs-layout";

/**
 * license-analyzer サブエージェントに流す skill ソースのデフォルト。
 *
 * **粒度は `/skills/audit/` 直下の 5 aspect を全部見せる**。以前は
 * `/skills/audit/license/` のように観点単独のパスを試したが、deepagents v1.9 の
 * `listSkillsFromBackend` は **source パスの直下にある "サブディレクトリ" を 1 階層
 * だけ走査** し、各サブディレクトリに `SKILL.md` があるかを見る方式なので、
 * `/skills/audit/license/` を source にすると中身は `SKILL.md` (ファイル) だけで
 * サブディレクトリが無いため 0 skill しか返らない。これを回避するには
 * (1) skills/ の物理レイアウトを再構造化するか、(2) audit/ 全体を見せて LLM の
 * description マッチで実質的な選択を任せるかの 2 択。本プロジェクトでは (2) を
 * 採用し、観測サブエージェントには audit 5 observation 分の metadata すべてを
 * 見せる (本文は段階的開示で必要分だけ読む)。**report 系は流れない** ので、
 * subagent/main の主たる filter 境界は "audit vs report" になる。
 *
 * deepagents v1.9 では custom subagent はメインの skills を継承しない
 * (general-purpose だけが継承) ため、各 factory で明示的に skill パスを返す
 * 必要がある。ここを省略すると license-analyzer は SKILL.md を一切読まずに動く。
 */
export const DEFAULT_LICENSE_ANALYZER_SKILLS: readonly string[] = [
  "/skills/audit/",
] as const;

export interface LicenseAnalyzerOptions {
  /**
   * サブエージェントに注入するツール群。省略時は `fetch_github` のデフォルト実装を使う。
   * テストや本番環境で別のクライアントを使いたい場合は明示的に渡す。
   */
  readonly tools?: readonly StructuredTool[];

  /**
   * このサブエージェントに流す skill ソースのリスト (仮想パス)。
   * 省略時は {@link DEFAULT_LICENSE_ANALYZER_SKILLS}。空配列 `[]` を渡すと
   * skills middleware は何も読まず、実質 skill 無効化のままこの factory が
   * 作るサブエージェントを構成できる (スモークテスト等で使える)。
   */
  readonly skills?: readonly string[];
}

/**
 * ライセンス監査に特化したサブエージェントの仕様を構築する。
 *
 * 責務:
 *   - 対象 OSS のメインライセンスを特定 (SPDX identifier)
 *   - 特殊ライセンス (Elastic License / SSPL / BSL 等) の商用利用制約を明記
 *   - 主要依存ライブラリのライセンス互換性を確認
 *   - 調査結果を `/raw/license/result.json` に構造化して書き出す
 */
export function createLicenseAnalyzerSubAgent(
  options: LicenseAnalyzerOptions = {},
): SubAgent {
  const tools = [
    ...(options.tools ?? [createFetchGithubTool()]),
  ];
  const skills = options.skills ?? DEFAULT_LICENSE_ANALYZER_SKILLS;

  const outputPath = rawPath("license", "result.json");

  return {
    name: "license-analyzer",
    description:
      "OSS リポジトリのライセンス種別と依存ライブラリとの互換性を調査する。ライセンス観点での監査が必要な場合にメインエージェントが委譲する。",
    skills: [...skills],
    systemPrompt: `あなたはライセンス監査に特化したサブエージェントです。

ミッション:
1. 対象 OSS リポジトリのメインライセンスを特定する (SPDX identifier)
2. 特殊ライセンス (Elastic License / SSPL / BSL 等) の場合は商用利用制約を明記する
3. 主要な依存ライブラリとの互換性に疑問があれば検出する
4. 調査結果を ${outputPath} に JSON として書き出す

出力フォーマット:
{
  "spdx_id": "MIT" | "Apache-2.0" | "Elastic-2.0" | ...,
  "license_name": "人間可読のライセンス名",
  "commercial_use": "allowed" | "restricted" | "prohibited" | "unknown",
  "compatibility_concerns": ["..."],
  "notes": "根拠となった一次情報 (GitHub のメタデータ等) への言及"
}

利用可能なツール:
- fetch_github(owner, repo): GitHub のリポジトリメタデータを取得する。メインライセンスは license.spdx_id で確認できる
- write_file(path, content): 結果を仮想ファイルシステムに保存する (${outputPath} を使うこと)
- read_file(path): 既存の raw データを読む必要がある場合に使う

原則:
- ファクトを重視し、推測は避ける
- 不明点は "unknown" としてマークする
- 憶測や主観的評価は書かない`,
    tools: tools as StructuredTool[],
  };
}
