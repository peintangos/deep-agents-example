/**
 * GitHub REST API の薄いクライアント。
 *
 * 目的:
 *   - 監査サブエージェントが GitHub リポジトリのメタデータを取得する共通手段
 *   - fetch を差し替え可能にして単体テストを容易にする
 *   - rate limit / retry / cache は Middleware (spec-008) の責務として持たない
 */

export interface GitHubRepoMetadata {
  readonly full_name: string;
  readonly description: string | null;
  readonly stargazers_count: number;
  readonly forks_count: number;
  readonly open_issues_count: number;
  readonly license: { readonly spdx_id: string | null; readonly name: string | null } | null;
  readonly default_branch: string;
  readonly archived: boolean;
  readonly pushed_at: string;
  readonly created_at: string;
  readonly html_url: string;
}

export interface GitHubClientOptions {
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly userAgent?: string;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubClient {
  getRepo(owner: string, repo: string): Promise<GitHubRepoMetadata>;
}

export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "https://api.github.com";
  const userAgent = options.userAgent ?? "deep-agents-example/0.1.0";

  async function request<T>(path: string): Promise<T> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": userAgent,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetchFn(url, { headers });
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        url,
        `GitHub API ${response.status} ${response.statusText} for ${url}`,
      );
    }
    return (await response.json()) as T;
  }

  return {
    async getRepo(owner, repo) {
      return request<GitHubRepoMetadata>(`/repos/${owner}/${repo}`);
    },
  };
}
