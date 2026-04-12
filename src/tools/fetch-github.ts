import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createGitHubClient, type GitHubClient } from "../clients/github";

const fetchGithubSchema = z.object({
  owner: z.string().min(1).describe("GitHub リポジトリのオーナー名 (例: mastra-ai)"),
  repo: z.string().min(1).describe("GitHub リポジトリ名 (例: mastra)"),
});

/**
 * LLM が呼び出す `fetch_github` ツールを生成する。
 * client を DI 可能にすることで、テストでは fake クライアントを注入できる。
 */
export function createFetchGithubTool(client: GitHubClient = createGitHubClient()) {
  return tool(
    async ({ owner, repo }) => {
      const metadata = await client.getRepo(owner, repo);
      return JSON.stringify(metadata, null, 2);
    },
    {
      name: "fetch_github",
      description:
        "GitHub の特定リポジトリのメタデータ (stars / forks / license / default_branch / pushed_at など) を取得する。監査サブエージェントが対象 OSS の基本情報を得るために使う。",
      schema: fetchGithubSchema,
    },
  );
}
