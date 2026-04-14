import type { SubAgent } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import { createFetchGithubTool } from "../tools/fetch-github";
import { rawPath } from "../fs-layout";

/**
 * maintenance-health サブエージェントに流す skill ソースのデフォルト。
 * 詳細は license-analyzer.ts の解説参照。
 */
export const DEFAULT_MAINTENANCE_HEALTH_SKILLS: readonly string[] = [
  "/skills/audit/maintenance/",
] as const;

export interface MaintenanceHealthOptions {
  readonly tools?: readonly StructuredTool[];
  /**
   * このサブエージェントに流す skill ソースのリスト (仮想パス)。
   * 省略時は {@link DEFAULT_MAINTENANCE_HEALTH_SKILLS}。
   */
  readonly skills?: readonly string[];
}

/**
 * メンテナンス健全性に特化したサブエージェントの仕様を構築する。
 *
 * 責務:
 *   - 対象 OSS の活発度 (コミット頻度・最終 push 日) を評価する
 *   - Open Issues 数とレスポンスの速さを見る
 *   - archived / deprecated 状態をチェックする
 *   - 結果を `/raw/maintenance/result.json` に構造化して書き出す
 */
export function createMaintenanceHealthSubAgent(
  options: MaintenanceHealthOptions = {},
): SubAgent {
  const tools = [...(options.tools ?? [createFetchGithubTool()])];
  const skills = options.skills ?? DEFAULT_MAINTENANCE_HEALTH_SKILLS;
  const outputPath = rawPath("maintenance", "result.json");

  return {
    name: "maintenance-health",
    description:
      "OSS のメンテナンス健全性 (活発度 / メンテナ応答性 / archived 状態など) を評価する。メンテナンス観点での監査が必要な場合に委譲する。",
    skills: [...skills],
    systemPrompt: `あなたは OSS のメンテナンス健全性を評価するサブエージェントです。

ミッション:
1. 対象 OSS の最終 push 日 (pushed_at) と作成日 (created_at) を取得する
2. Open Issues 数を確認する
3. archived フラグをチェックし、プロジェクトが deprecated になっていないか確認する
4. 上記を総合して "healthy" / "warning" / "stale" の 3 段階でステータスを付ける
5. 結果を ${outputPath} に JSON として書き出す

判定基準 (目安):
- healthy: pushed_at が 90 日以内、archived = false
- warning: pushed_at が 90〜365 日
- stale: pushed_at が 365 日以上、または archived = true

出力フォーマット:
{
  "status": "healthy" | "warning" | "stale",
  "pushed_at": "YYYY-MM-DDTHH:MM:SSZ",
  "created_at": "YYYY-MM-DDTHH:MM:SSZ",
  "open_issues_count": 0,
  "archived": false,
  "notes": "判定の根拠となった具体的な日付や閾値"
}

利用可能なツール:
- fetch_github(owner, repo): GitHub のリポジトリメタデータ取得
- write_file(path, content): 結果を仮想 FS に保存 (${outputPath})
- read_file(path): 既存の raw データ参照

原則:
- メタデータに含まれる数値と日付だけを根拠にする
- バス係数のような推定値は今フェーズでは算出しない (後続 spec で拡張)
- 不明点は "unknown" と明示する`,
    tools: tools as StructuredTool[],
  };
}
