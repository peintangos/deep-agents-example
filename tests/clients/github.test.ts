import { describe, it, expect, vi } from "vitest";
import {
  createGitHubClient,
  GitHubApiError,
  type GitHubRepoMetadata,
} from "../../src/clients/github";

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

function fakeFetch(response: Partial<Response> & { jsonBody?: unknown }) {
  const impl = async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      json: async () => response.jsonBody,
    } as unknown as Response;
  };
  return vi.fn(impl);
}

describe("createGitHubClient", () => {
  it("returns repo metadata on a successful request", async () => {
    const fetch = fakeFetch({ jsonBody: fakeRepo });
    const client = createGitHubClient({ fetch, token: "test-token" });

    const result = await client.getRepo("mastra-ai", "mastra");

    expect(result).toEqual(fakeRepo);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends Authorization header and correct URL when a token is configured", async () => {
    const fetch = fakeFetch({ jsonBody: fakeRepo });
    const client = createGitHubClient({ fetch, token: "test-token" });

    await client.getRepo("mastra-ai", "mastra");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/mastra-ai/mastra",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": expect.stringContaining("deep-agents-example"),
        }),
      }),
    );
  });

  it("omits Authorization header when no token is provided", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const fetch = fakeFetch({ jsonBody: fakeRepo });
      const client = createGitHubClient({ fetch });
      await client.getRepo("mastra-ai", "mastra");

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.not.objectContaining({ Authorization: expect.anything() }),
        }),
      );
    } finally {
      if (originalToken !== undefined) process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it("throws GitHubApiError on non-2xx response", async () => {
    const fetch = fakeFetch({
      ok: false,
      status: 404,
      statusText: "Not Found",
      jsonBody: {},
    });
    const client = createGitHubClient({ fetch });

    await expect(client.getRepo("ghost", "ghost")).rejects.toBeInstanceOf(GitHubApiError);

    try {
      await client.getRepo("ghost", "ghost");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      if (error instanceof GitHubApiError) {
        expect(error.status).toBe(404);
        expect(error.url).toContain("/repos/ghost/ghost");
      }
    }
  });

  it("honors a custom baseUrl", async () => {
    const fetch = fakeFetch({ jsonBody: fakeRepo });
    const client = createGitHubClient({
      fetch,
      baseUrl: "https://ghe.example.com/api/v3",
      token: "x",
    });

    await client.getRepo("a", "b");

    expect(fetch).toHaveBeenCalledWith(
      "https://ghe.example.com/api/v3/repos/a/b",
      expect.anything(),
    );
  });
});
