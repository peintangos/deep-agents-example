import type { SubAgent } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import { createQueryOsvTool } from "../tools/query-osv";
import { rawPath } from "../fs-layout";

export interface SecurityAuditorOptions {
  readonly tools?: readonly StructuredTool[];
}

/**
 * セキュリティ脆弱性監査に特化したサブエージェントの仕様を構築する。
 *
 * 責務:
 *   - 対象 OSS の依存ライブラリを調査し、OSV データベースで既知の脆弱性を洗い出す
 *   - CVE の重大度 (CVSS v3 score) と publish 日を記録する
 *   - パッチバージョンの有無を確認する
 *   - 結果を `/raw/security/result.json` に構造化して書き出す
 */
export function createSecurityAuditorSubAgent(
  options: SecurityAuditorOptions = {},
): SubAgent {
  const tools = [...(options.tools ?? [createQueryOsvTool()])];
  const outputPath = rawPath("security", "result.json");

  return {
    name: "security-auditor",
    description:
      "OSS の依存ライブラリの脆弱性を OSV データベースで調査する。セキュリティ観点での監査が必要な場合にメインエージェントが委譲する。",
    systemPrompt: `あなたはセキュリティ脆弱性監査に特化したサブエージェントです。

ミッション:
1. 対象 OSS の直接依存ライブラリ (package.json 等から特定) を洗い出す
2. 各ライブラリを OSV データベースで照会し、既知の脆弱性を取得する
3. 深刻度 (CVSS v3 score) と publish/modified 日を記録する
4. パッチバージョンが提供されているかを確認する
5. 調査結果を ${outputPath} に JSON として書き出す

出力フォーマット:
{
  "scanned_packages": [
    { "name": "...", "ecosystem": "npm", "version": "..." }
  ],
  "findings": [
    {
      "package": "...",
      "id": "CVE-xxxx-yyyy / GHSA-xxxx",
      "summary": "...",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "unknown",
      "fixed_in": "...",
      "published": "YYYY-MM-DD"
    }
  ],
  "notes": "一次情報 (OSV クエリ結果) への言及"
}

利用可能なツール:
- query_osv(packageName, ecosystem, version?): OSV データベースに問い合わせ
- write_file(path, content): 結果を仮想ファイルシステムに保存 (${outputPath} を使うこと)
- read_file(path): 既存の raw データを読む必要がある場合に使う

原則:
- OSV からのレスポンスに含まれる情報だけを根拠とし、推測しない
- 脆弱性が見つからなかった場合は findings を空配列にする (null や "none" にしない)
- 不明な深刻度は "unknown" とする`,
    tools: tools as StructuredTool[],
  };
}
