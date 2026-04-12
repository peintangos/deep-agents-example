import { describe, it, expect, vi } from "vitest";
import { createOsvClient, OsvApiError, type OsvQueryResult } from "../../src/clients/osv";

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

describe("createOsvClient", () => {
  it("returns vulnerability data on success", async () => {
    const body: OsvQueryResult = {
      vulns: [
        {
          id: "GHSA-xxxx-yyyy-zzzz",
          summary: "Prototype pollution",
          severity: [{ type: "CVSS_V3", score: "7.5" }],
          published: "2025-01-15T00:00:00Z",
          modified: "2025-02-01T00:00:00Z",
        },
      ],
    };
    const fetch = fakeFetch({ jsonBody: body });
    const client = createOsvClient({ fetch });

    const result = await client.query({
      package: { name: "lodash", ecosystem: "npm" },
      version: "4.17.20",
    });

    expect(result.vulns).toHaveLength(1);
    expect(result.vulns?.[0]?.id).toBe("GHSA-xxxx-yyyy-zzzz");
  });

  it("sends a POST with JSON body to /v1/query", async () => {
    const fetch = fakeFetch({ jsonBody: { vulns: [] } });
    const client = createOsvClient({ fetch });

    await client.query({ package: { name: "axios", ecosystem: "npm" } });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.osv.dev/v1/query",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );

    const call = fetch.mock.calls[0];
    expect(call).toBeDefined();
    const init = call?.[1];
    expect(init?.body).toBeTypeOf("string");
    const parsed = JSON.parse(init?.body as string) as {
      package: { name: string; ecosystem: string };
    };
    expect(parsed.package.name).toBe("axios");
    expect(parsed.package.ecosystem).toBe("npm");
  });

  it("returns empty result when no vulnerabilities are found", async () => {
    const fetch = fakeFetch({ jsonBody: {} });
    const client = createOsvClient({ fetch });

    const result = await client.query({ package: { name: "safe-lib", ecosystem: "npm" } });

    expect(result.vulns).toBeUndefined();
  });

  it("throws OsvApiError on non-2xx response", async () => {
    const fetch = fakeFetch({ ok: false, status: 500, statusText: "Server Error", jsonBody: {} });
    const client = createOsvClient({ fetch });

    await expect(
      client.query({ package: { name: "broken", ecosystem: "npm" } }),
    ).rejects.toBeInstanceOf(OsvApiError);
  });
});
