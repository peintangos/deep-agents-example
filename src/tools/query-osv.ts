import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createOsvClient, type OsvClient } from "../clients/osv";

const queryOsvSchema = z.object({
  packageName: z.string().min(1).describe("パッケージ名 (例: lodash)"),
  ecosystem: z
    .string()
    .min(1)
    .describe("パッケージエコシステム (例: npm / PyPI / crates.io)"),
  version: z
    .string()
    .optional()
    .describe("特定バージョンの脆弱性だけを調べる場合に指定 (省略時は全バージョン)"),
});

/**
 * LLM が呼び出す `query_osv` ツールを生成する。
 * OSV の脆弱性データベースに問い合わせ、該当する vulnerabilities を JSON として返す。
 */
export function createQueryOsvTool(client: OsvClient = createOsvClient()) {
  return tool(
    async ({ packageName, ecosystem, version }) => {
      const result = await client.query({
        package: { name: packageName, ecosystem },
        ...(version !== undefined ? { version } : {}),
      });
      return JSON.stringify(result, null, 2);
    },
    {
      name: "query_osv",
      description:
        "OSV (Open Source Vulnerabilities) データベースに問い合わせて、指定パッケージの既知の脆弱性を取得する。security-auditor サブエージェントが依存ライブラリの CVE を洗い出すために使う。",
      schema: queryOsvSchema,
    },
  );
}
