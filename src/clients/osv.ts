/**
 * OSV (Open Source Vulnerabilities) API の薄いクライアント。
 *
 * 目的:
 *   - security-auditor サブエージェントが依存ライブラリの脆弱性を照会する共通手段
 *   - 認証不要 (レート制限はあるが緩い)
 *   - fetch を差し替え可能にしてテストを容易にする
 */

export interface OsvPackage {
  readonly name: string;
  readonly ecosystem: string;
}

export interface OsvQuery {
  readonly package: OsvPackage;
  readonly version?: string;
}

export interface OsvSeverity {
  readonly type: string;
  readonly score: string;
}

export interface OsvVulnerability {
  readonly id: string;
  readonly summary?: string;
  readonly details?: string;
  readonly severity?: readonly OsvSeverity[];
  readonly published?: string;
  readonly modified?: string;
}

export interface OsvQueryResult {
  readonly vulns?: readonly OsvVulnerability[];
}

export interface OsvClientOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

export class OsvApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OsvApiError";
  }
}

export interface OsvClient {
  query(q: OsvQuery): Promise<OsvQueryResult>;
}

export function createOsvClient(options: OsvClientOptions = {}): OsvClient {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "https://api.osv.dev";

  return {
    async query(q) {
      const url = `${baseUrl}/v1/query`;
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(q),
      });
      if (!response.ok) {
        throw new OsvApiError(
          response.status,
          `OSV API ${response.status} ${response.statusText} for ${url}`,
        );
      }
      return (await response.json()) as OsvQueryResult;
    },
  };
}
