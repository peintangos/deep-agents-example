import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

import {
  AUDIT_POLICY_MEMORY_PATH,
  DEFAULT_AUDIT_POLICY,
  WEIGHTABLE_AUDIT_ASPECTS,
  readAuditPolicy,
  writeAuditPolicy,
  type AuditPolicy,
} from "../../src/memory/policy";
import {
  MEMORY_NAMESPACE,
  memoryStoreKey,
  readMemoryJson,
  writeMemoryJson,
} from "../../src/memory/store-helpers";

/**
 * spec-005: 監査ポリシーの長期メモリヘルパー (`src/memory/policy.ts`) と
 * その下回りである BaseStore 直結ヘルパー (`src/memory/store-helpers.ts`) の
 * ユニットテスト。
 *
 * deepagents の `/memories/` → StoreBackend ルーティングと相互運用するために、
 * - namespace は ["filesystem"]
 * - key は `/memories/` プレフィックスを剥がした `/audit-policy.json`
 * - value は FileData v2 (content / created_at / modified_at)
 *
 * という規約に揃っていることを assert しておくと、deepagents 側の round-trip が
 * 壊れたときにすぐ検出できる。
 */

describe("memoryStoreKey (prefix stripping)", () => {
  it("strips the /memories/ prefix and keeps a leading slash", () => {
    expect(memoryStoreKey("/memories/audit-policy.json")).toBe(
      "/audit-policy.json",
    );
  });

  it("supports nested paths under /memories/ such as history files", () => {
    expect(memoryStoreKey("/memories/history/mastra-2026-04.json")).toBe(
      "/history/mastra-2026-04.json",
    );
  });

  it("rejects paths that do not start with /memories/", () => {
    expect(() => memoryStoreKey("/raw/license/result.json")).toThrowError(
      /under \/memories\//,
    );
  });

  it("rejects the bare /memories/ root", () => {
    expect(() => memoryStoreKey("/memories/")).toThrowError(
      /file path/,
    );
  });
});

describe("readMemoryJson / writeMemoryJson round-trip", () => {
  it("returns null when the key does not exist", async () => {
    const store = new InMemoryStore();
    const value = await readMemoryJson<AuditPolicy>(
      store,
      "/memories/audit-policy.json",
    );
    expect(value).toBeNull();
  });

  it("round-trips an arbitrary JSON value", async () => {
    const store = new InMemoryStore();
    const data = { hello: "world", count: 42, nested: { a: [1, 2, 3] } };
    await writeMemoryJson(store, "/memories/test.json", data);
    const got = await readMemoryJson<typeof data>(store, "/memories/test.json");
    expect(got).toEqual(data);
  });

  it("stores a FileData v2 compatible value (content / created_at / modified_at)", async () => {
    const store = new InMemoryStore();
    await writeMemoryJson(
      store,
      "/memories/audit-policy.json",
      { weights: { license: 1.0 } },
      { nowIso: "2026-04-14T00:00:00.000Z" },
    );

    const item = await store.get(
      [...MEMORY_NAMESPACE],
      "/audit-policy.json",
    );
    expect(item).not.toBeNull();
    const value = item?.value as Record<string, unknown>;
    expect(typeof value.content).toBe("string");
    expect(value.mimeType).toBe("application/json");
    expect(value.created_at).toBe("2026-04-14T00:00:00.000Z");
    expect(value.modified_at).toBe("2026-04-14T00:00:00.000Z");
    expect(JSON.parse(value.content as string)).toEqual({
      weights: { license: 1.0 },
    });
  });

  it("preserves created_at across upserts and only refreshes modified_at", async () => {
    const store = new InMemoryStore();
    await writeMemoryJson(
      store,
      "/memories/audit-policy.json",
      { notes: "first" },
      { nowIso: "2026-04-14T00:00:00.000Z" },
    );
    await writeMemoryJson(
      store,
      "/memories/audit-policy.json",
      { notes: "second" },
      { nowIso: "2026-04-15T12:34:56.000Z" },
    );

    const item = await store.get(
      [...MEMORY_NAMESPACE],
      "/audit-policy.json",
    );
    const value = item?.value as Record<string, unknown>;
    expect(value.created_at).toBe("2026-04-14T00:00:00.000Z");
    expect(value.modified_at).toBe("2026-04-15T12:34:56.000Z");
    expect(JSON.parse(value.content as string)).toEqual({ notes: "second" });
  });

  it("returns null when the stored value has an incompatible shape", async () => {
    const store = new InMemoryStore();
    // Bypass the helper and put a junk value to simulate corruption.
    await store.put([...MEMORY_NAMESPACE], "/audit-policy.json", {
      not: "a-file-data",
    });
    const got = await readMemoryJson<AuditPolicy>(
      store,
      "/memories/audit-policy.json",
    );
    expect(got).toBeNull();
  });
});

describe("AuditPolicy constants", () => {
  it("exposes the canonical /memories/ path", () => {
    expect(AUDIT_POLICY_MEMORY_PATH).toBe("/memories/audit-policy.json");
  });

  it("treats the default policy as an empty object", () => {
    expect(DEFAULT_AUDIT_POLICY).toEqual({});
  });

  it("excludes critic from the weightable aspects list", () => {
    expect(WEIGHTABLE_AUDIT_ASPECTS).toEqual([
      "license",
      "security",
      "maintenance",
      "api-stability",
      "community",
    ]);
    expect(WEIGHTABLE_AUDIT_ASPECTS).not.toContain("critic");
  });
});

describe("readAuditPolicy / writeAuditPolicy", () => {
  it("returns null when no policy has been written yet", async () => {
    const store = new InMemoryStore();
    expect(await readAuditPolicy(store)).toBeNull();
  });

  it("round-trips a fully populated policy", async () => {
    const store = new InMemoryStore();
    const policy: AuditPolicy = {
      weights: {
        license: 0.3,
        security: 0.4,
        maintenance: 0.1,
        "api-stability": 0.1,
        community: 0.1,
      },
      excludedChecks: ["license:gpl-cross-check", "security:dev-dep-cve"],
      notes: "商用 SaaS 配布が前提なので copyleft は致命",
    };
    await writeAuditPolicy(store, policy);
    expect(await readAuditPolicy(store)).toEqual(policy);
  });

  it("round-trips a sparsely populated policy (only notes)", async () => {
    const store = new InMemoryStore();
    const policy: AuditPolicy = { notes: "weights は default のままで良い" };
    await writeAuditPolicy(store, policy);
    expect(await readAuditPolicy(store)).toEqual(policy);
  });

  it("supports overwriting an existing policy", async () => {
    const store = new InMemoryStore();
    await writeAuditPolicy(store, { notes: "first" });
    await writeAuditPolicy(store, { notes: "second" });
    expect(await readAuditPolicy(store)).toEqual({ notes: "second" });
  });

  it("isolates two stores from each other", async () => {
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();
    await writeAuditPolicy(storeA, { notes: "A only" });
    expect(await readAuditPolicy(storeA)).toEqual({ notes: "A only" });
    expect(await readAuditPolicy(storeB)).toBeNull();
  });

  it("shares state when two callers point at the same store (cross-session simulation)", async () => {
    const sharedStore = new InMemoryStore();
    await writeAuditPolicy(sharedStore, {
      weights: { security: 0.5 },
      notes: "session 1 で書いた",
    });

    // 別の "セッション" を模倣: 同じ store を渡して別のローカル変数で読む。
    const sessionTwoView = await readAuditPolicy(sharedStore);
    expect(sessionTwoView).toEqual({
      weights: { security: 0.5 },
      notes: "session 1 で書いた",
    });
  });
});
