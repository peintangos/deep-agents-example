import { describe, it, expect, vi } from "vitest";
import { createFetchGithubTool } from "../../src/tools/fetch-github";
import type { GitHubClient, GitHubRepoMetadata } from "../../src/clients/github";

const fakeRepo: GitHubRepoMetadata = {
  full_name: "mastra-ai/mastra",
  description: "TypeScript AI agent framework",
  stargazers_count: 42000,
  forks_count: 3100,
  open_issues_count: 128,
  license: { spdx_id: "Elastic-2.0", name: "Elastic License 2.0" },
  default_branch: "main",
  archived: false,
  pushed_at: "2026-04-01T12:00:00Z",
  created_at: "2024-08-15T09:00:00Z",
  html_url: "https://github.com/mastra-ai/mastra",
};

function fakeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getRepo: vi.fn(async () => fakeRepo),
    ...overrides,
  };
}

describe("createFetchGithubTool", () => {
  it("exposes the canonical tool name and a descriptive help text", () => {
    const t = createFetchGithubTool(fakeClient());
    expect(t.name).toBe("fetch_github");
    expect(t.description).toContain("GitHub");
  });

  it("delegates to the injected client and returns JSON text", async () => {
    const client = fakeClient();
    const t = createFetchGithubTool(client);

    const result = await t.invoke({ owner: "mastra-ai", repo: "mastra" });

    expect(client.getRepo).toHaveBeenCalledWith("mastra-ai", "mastra");
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result as string) as GitHubRepoMetadata;
    expect(parsed.full_name).toBe("mastra-ai/mastra");
    expect(parsed.license?.spdx_id).toBe("Elastic-2.0");
  });

  it("propagates errors raised by the underlying client", async () => {
    const error = new Error("404 Not Found");
    const client = fakeClient({ getRepo: vi.fn(async () => Promise.reject(error)) });
    const t = createFetchGithubTool(client);

    await expect(t.invoke({ owner: "ghost", repo: "ghost" })).rejects.toThrow("404 Not Found");
  });
});
