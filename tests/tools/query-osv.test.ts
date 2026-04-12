import { describe, it, expect, vi } from "vitest";
import { createQueryOsvTool } from "../../src/tools/query-osv";
import type { OsvClient, OsvQuery, OsvQueryResult } from "../../src/clients/osv";

const fakeResult: OsvQueryResult = {
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

function fakeClient(result: OsvQueryResult = fakeResult): OsvClient & {
  query: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async (_q: OsvQuery) => result),
  };
}

describe("createQueryOsvTool", () => {
  it("exposes the canonical tool name and a descriptive help text", () => {
    const t = createQueryOsvTool(fakeClient());
    expect(t.name).toBe("query_osv");
    expect(t.description).toContain("OSV");
  });

  it("delegates to the injected client with the structured OSV query", async () => {
    const client = fakeClient();
    const t = createQueryOsvTool(client);

    const result = await t.invoke({
      packageName: "lodash",
      ecosystem: "npm",
      version: "4.17.20",
    });

    expect(client.query).toHaveBeenCalledWith({
      package: { name: "lodash", ecosystem: "npm" },
      version: "4.17.20",
    });
    const parsed = JSON.parse(result as string) as OsvQueryResult;
    expect(parsed.vulns).toHaveLength(1);
    expect(parsed.vulns?.[0]?.id).toBe("GHSA-xxxx-yyyy-zzzz");
  });

  it("omits version from the query when not provided", async () => {
    const client = fakeClient();
    const t = createQueryOsvTool(client);

    await t.invoke({ packageName: "axios", ecosystem: "npm" });

    const queryArg = client.query.mock.calls[0]?.[0] as OsvQuery;
    expect(queryArg.package).toEqual({ name: "axios", ecosystem: "npm" });
    expect(queryArg.version).toBeUndefined();
  });
});
