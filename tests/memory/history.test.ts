import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

import {
  auditHistoryMemoryPath,
  extractYearMonth,
  readAuditHistoryEntry,
  slugifyAuditTarget,
  writeAuditHistoryEntry,
  type AuditHistoryEntry,
} from "../../src/memory/history";

/**
 * spec-005: 監査履歴 (`/memories/history/<owner>-<repo>-<yyyy-mm>.json`) ヘルパーの
 * ユニットテスト。
 *
 * 履歴エントリは `GenerateAuditReportInput` をそのまま流用するので、reporter の
 * 入力と 1:1 対応する。reporter.test.ts と同じパターンで `baseEntry()` ヘルパを
 * 使い、テストごとに必要な部分だけを上書きする。
 */

function baseEntry(
  overrides: Partial<AuditHistoryEntry> = {},
): AuditHistoryEntry {
  return {
    target: { owner: "mastra-ai", repo: "mastra" },
    generatedAt: "2026-04-14T00:00:00.000Z",
    license: { spdx_id: "Elastic-2.0" },
    security: { known_vulnerabilities: [] },
    maintenance: { health: "healthy" },
    apiStability: { semver: "pre-1.0" },
    community: { stars: 12000 },
    critic: {
      overall_assessment: "warnings",
      findings: [
        {
          severity: "warning",
          aspect: "license",
          message: "SaaS 配布制約",
        },
      ],
    },
    ...overrides,
  };
}

describe("slugifyAuditTarget", () => {
  it("joins owner and repo with a hyphen", () => {
    expect(slugifyAuditTarget({ owner: "mastra-ai", repo: "mastra" })).toBe(
      "mastra-ai-mastra",
    );
  });

  it("preserves dots and underscores (allowed namespace characters)", () => {
    expect(
      slugifyAuditTarget({ owner: "foo_bar.baz", repo: "qux.quux_corge" }),
    ).toBe("foo_bar.baz-qux.quux_corge");
  });

  it("replaces unsafe characters with hyphens", () => {
    expect(slugifyAuditTarget({ owner: "a/b c", repo: "d e/f" })).toBe(
      "a-b-c-d-e-f",
    );
  });

  it("rejects empty owner or repo", () => {
    expect(() =>
      slugifyAuditTarget({ owner: "", repo: "mastra" }),
    ).toThrowError(/non-empty/);
    expect(() =>
      slugifyAuditTarget({ owner: "mastra-ai", repo: "" }),
    ).toThrowError(/non-empty/);
  });
});

describe("extractYearMonth", () => {
  it("extracts yyyy-mm from a full ISO timestamp", () => {
    expect(extractYearMonth("2026-04-14T00:00:00.000Z")).toBe("2026-04");
  });

  it("works with date-only strings", () => {
    expect(extractYearMonth("2025-12-31")).toBe("2025-12");
  });

  it("rejects non-ISO inputs", () => {
    expect(() => extractYearMonth("April 14 2026")).toThrowError(
      /ISO timestamp/,
    );
    expect(() => extractYearMonth("2026/04/14")).toThrowError(/ISO timestamp/);
  });
});

describe("auditHistoryMemoryPath", () => {
  it("constructs the canonical /memories/history/<slug>-<yyyy-mm>.json path", () => {
    expect(
      auditHistoryMemoryPath(
        { owner: "mastra-ai", repo: "mastra" },
        "2026-04",
      ),
    ).toBe("/memories/history/mastra-ai-mastra-2026-04.json");
  });

  it("rejects malformed yearMonth", () => {
    expect(() =>
      auditHistoryMemoryPath({ owner: "a", repo: "b" }, "2026-4"),
    ).toThrowError(/yyyy-mm/);
    expect(() =>
      auditHistoryMemoryPath({ owner: "a", repo: "b" }, "26-04"),
    ).toThrowError(/yyyy-mm/);
    expect(() =>
      auditHistoryMemoryPath({ owner: "a", repo: "b" }, "2026/04"),
    ).toThrowError(/yyyy-mm/);
  });
});

describe("readAuditHistoryEntry / writeAuditHistoryEntry", () => {
  it("returns null when no entry exists", async () => {
    const store = new InMemoryStore();
    expect(
      await readAuditHistoryEntry(
        store,
        { owner: "mastra-ai", repo: "mastra" },
        "2026-04",
      ),
    ).toBeNull();
  });

  it("round-trips an entry derived from generatedAt", async () => {
    const store = new InMemoryStore();
    const entry = baseEntry();
    await writeAuditHistoryEntry(store, entry);
    const got = await readAuditHistoryEntry(
      store,
      entry.target,
      "2026-04",
    );
    expect(got).toEqual(entry);
  });

  it("derives the path from entry.generatedAt (year/month)", async () => {
    const store = new InMemoryStore();
    await writeAuditHistoryEntry(
      store,
      baseEntry({ generatedAt: "2026-03-31T23:59:59.999Z" }),
    );

    // 同じ target の 4 月分は無く、3 月分だけが存在する状態になっているはず。
    expect(
      await readAuditHistoryEntry(
        store,
        { owner: "mastra-ai", repo: "mastra" },
        "2026-04",
      ),
    ).toBeNull();
    expect(
      await readAuditHistoryEntry(
        store,
        { owner: "mastra-ai", repo: "mastra" },
        "2026-03",
      ),
    ).not.toBeNull();
  });

  it("isolates entries by month so prior snapshots remain readable after a new run", async () => {
    const store = new InMemoryStore();
    await writeAuditHistoryEntry(
      store,
      baseEntry({
        generatedAt: "2026-03-15T00:00:00.000Z",
        license: { spdx_id: "Apache-2.0" },
      }),
    );
    await writeAuditHistoryEntry(
      store,
      baseEntry({
        generatedAt: "2026-04-14T00:00:00.000Z",
        license: { spdx_id: "Elastic-2.0" },
      }),
    );

    const march = await readAuditHistoryEntry(
      store,
      { owner: "mastra-ai", repo: "mastra" },
      "2026-03",
    );
    const april = await readAuditHistoryEntry(
      store,
      { owner: "mastra-ai", repo: "mastra" },
      "2026-04",
    );
    expect(march?.license).toEqual({ spdx_id: "Apache-2.0" });
    expect(april?.license).toEqual({ spdx_id: "Elastic-2.0" });
  });

  it("isolates entries by target so other repos do not bleed in", async () => {
    const store = new InMemoryStore();
    await writeAuditHistoryEntry(
      store,
      baseEntry({
        target: { owner: "mastra-ai", repo: "mastra" },
        generatedAt: "2026-04-14T00:00:00.000Z",
      }),
    );
    expect(
      await readAuditHistoryEntry(
        store,
        { owner: "other-org", repo: "other-repo" },
        "2026-04",
      ),
    ).toBeNull();
  });

  it("overwrites an entry within the same month (last write wins)", async () => {
    const store = new InMemoryStore();
    await writeAuditHistoryEntry(
      store,
      baseEntry({ critic: null }),
    );
    await writeAuditHistoryEntry(
      store,
      baseEntry({
        critic: {
          overall_assessment: "pass",
          findings: [],
        },
      }),
    );
    const got = await readAuditHistoryEntry(
      store,
      { owner: "mastra-ai", repo: "mastra" },
      "2026-04",
    );
    expect(got?.critic).toEqual({
      overall_assessment: "pass",
      findings: [],
    });
  });
});
