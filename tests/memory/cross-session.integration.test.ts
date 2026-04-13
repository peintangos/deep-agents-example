import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import { CompositeBackend, StateBackend, StoreBackend } from "deepagents";

import { createAuditAgent } from "../../src/agent";
import { AUDIT_POLICY_MEMORY_PATH } from "../../src/memory/policy";
import {
  readAuditPolicy,
  writeAuditPolicy,
  type AuditPolicy,
} from "../../src/memory/policy";
import {
  readUserPreferences,
  writeUserPreferences,
} from "../../src/memory/preferences";
import {
  readAuditHistoryEntry,
  writeAuditHistoryEntry,
  type AuditHistoryEntry,
} from "../../src/memory/history";

/**
 * spec-005 統合テスト: 同一 BaseStore を共有した 2 回の `createAuditAgent` 呼び出しで
 * `/memories/` 配下のデータが「セッションを跨いで」保持されることを検証する。
 *
 * **テスト戦略の選択**:
 *
 * 本来の Gherkin 受け入れ条件は「前回の監査実行でメモリに書いた値が、次回の
 * 監査実行で復元される」というもの。これを LLM 呼び出し込みで E2E で検証するには
 * OpenRouter API key と GitHub token、そして実行時間が必要になり、決定論性が
 * 失われる (smoke.test.ts 側でその種の "実 API E2E" は spec-009 に分離する方針が
 * すでに確立済み)。
 *
 * 代替として本テストは:
 *
 *   1. `createAuditAgent({ store: sharedStore })` をセッション A の代理として呼ぶ
 *   2. 監査ポリシー / ユーザー好み / 履歴エントリを `sharedStore` に書く
 *      (helper 経由 = orchestrator がやることを模擬)
 *   3. **新しい** `createAuditAgent({ store: sharedStore })` をセッション B の
 *      代理として呼ぶ (BaseStore は同じインスタンス)
 *   4. セッション B の view から helper 経由で読み出し、3 種類のメモリすべてが
 *      復元されることを assert
 *
 * これにより「**配線が壊れていない** + **永続化規約 (namespace / prefix / FileData
 * v2) が helper と一致している**」という最重要不変条件を、LLM を呼ばずに
 * 決定論的に守れる。LLM が絡む真の E2E は spec-009 で扱う。
 */
describe("spec-005 cross-session memory persistence (no LLM)", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    // ChatOpenAI コンストラクタ通過のため dummy API key を入れる。
    // 実 API は呼ばないので値の中身は何でもよい。
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it("audit policy survives across two createAuditAgent calls sharing the same store", async () => {
    const sharedStore = new InMemoryStore();

    // --- Session A ---
    const agentA = createAuditAgent({ store: sharedStore });
    expect(agentA).toBeDefined();

    const policy: AuditPolicy = {
      weights: { security: 0.5, license: 0.3, community: 0.2 },
      excludedChecks: ["license:gpl-cross-check"],
      notes: "session A で設定したポリシー",
    };
    await writeAuditPolicy(sharedStore, policy);

    // --- Session B (新しい agent インスタンスだが store は同一) ---
    const agentB = createAuditAgent({ store: sharedStore });
    expect(agentB).toBeDefined();
    expect(agentB).not.toBe(agentA);

    const recovered = await readAuditPolicy(sharedStore);
    expect(recovered).toEqual(policy);
  });

  it("user preferences survive across two createAuditAgent calls sharing the same store", async () => {
    const sharedStore = new InMemoryStore();

    createAuditAgent({ store: sharedStore });
    await writeUserPreferences(sharedStore, {
      tone: "formal",
      priorityAspects: ["security", "license"],
      notes: "session A で初回ユーザーから収集",
    });

    createAuditAgent({ store: sharedStore });
    const recovered = await readUserPreferences(sharedStore);
    expect(recovered).toEqual({
      tone: "formal",
      priorityAspects: ["security", "license"],
      notes: "session A で初回ユーザーから収集",
    });
  });

  it("history entries survive across two createAuditAgent calls sharing the same store", async () => {
    const sharedStore = new InMemoryStore();

    createAuditAgent({ store: sharedStore });

    const previousMonth: AuditHistoryEntry = {
      target: { owner: "mastra-ai", repo: "mastra" },
      generatedAt: "2026-03-15T00:00:00.000Z",
      license: { spdx_id: "Apache-2.0" },
      security: { known_vulnerabilities: [] },
      maintenance: { health: "healthy" },
      apiStability: { semver: "pre-1.0" },
      community: { stars: 11500 },
      critic: { overall_assessment: "pass", findings: [] },
    };
    await writeAuditHistoryEntry(sharedStore, previousMonth);

    createAuditAgent({ store: sharedStore });
    const recovered = await readAuditHistoryEntry(
      sharedStore,
      { owner: "mastra-ai", repo: "mastra" },
      "2026-03",
    );
    expect(recovered).toEqual(previousMonth);
  });

  it("a fresh store does not leak data into the next createAuditAgent call (negative control)", async () => {
    const storeA = new InMemoryStore();
    createAuditAgent({ store: storeA });
    await writeAuditPolicy(storeA, { notes: "store A only" });

    // 別の store なのでデータは見えてはいけない。
    const storeB = new InMemoryStore();
    createAuditAgent({ store: storeB });
    expect(await readAuditPolicy(storeB)).toBeNull();
    expect(await readUserPreferences(storeB)).toBeNull();
  });

  it("data written via the helper is readable through CompositeBackend(/memories/ → StoreBackend) at the agent's path", async () => {
    // 配線証跡: helper の規約 (namespace + prefix 剥がし + FileData v2 形状) が
    // 実際に deepagents の CompositeBackend 経由で round-trip するかを、LLM を
    // 一切呼ばずに検証する。これが壊れていると、agent から
    // `read_file("/memories/audit-policy.json")` を呼んだときに helper が書いた
    // データが見えないという致命的な配線 gap が生まれる。
    //
    // StoreBackend / StateBackend は legacy mode (`{ state, store }` を渡す形)
    // で構築する。zero-arg mode は LangGraph 実行コンテキストの `getStore()` を
    // 要求するため、テストの素の Node ランタイム下では使えない。`state` の値は
    // StoreBackend 内では参照されず、`"state" in obj` の判定にだけ使われる。
    const sharedStore = new InMemoryStore();

    await writeAuditPolicy(sharedStore, {
      notes: "round-trip via CompositeBackend",
    });

    const stateAndStore = { state: {}, store: sharedStore };
    const composite = new CompositeBackend(new StateBackend(stateAndStore), {
      "/memories/": new StoreBackend(stateAndStore),
    });

    const result = await composite.read(AUDIT_POLICY_MEMORY_PATH);
    expect(result.error).toBeUndefined();
    expect(typeof result.content).toBe("string");
    const parsed = JSON.parse(result.content as string);
    expect(parsed).toEqual({ notes: "round-trip via CompositeBackend" });
  });

  it("all three memory layers coexist on the same shared store without colliding", async () => {
    const sharedStore = new InMemoryStore();

    createAuditAgent({ store: sharedStore });
    await writeAuditPolicy(sharedStore, { notes: "policy" });
    await writeUserPreferences(sharedStore, {
      tone: "polite",
      notes: "preferences",
    });
    await writeAuditHistoryEntry(sharedStore, {
      target: { owner: "mastra-ai", repo: "mastra" },
      generatedAt: "2026-04-14T00:00:00.000Z",
      license: { spdx_id: "Elastic-2.0" },
      security: null,
      maintenance: null,
      apiStability: null,
      community: null,
      critic: null,
    });

    createAuditAgent({ store: sharedStore });
    expect(await readAuditPolicy(sharedStore)).toEqual({ notes: "policy" });
    expect(await readUserPreferences(sharedStore)).toEqual({
      tone: "polite",
      notes: "preferences",
    });
    expect(
      await readAuditHistoryEntry(
        sharedStore,
        { owner: "mastra-ai", repo: "mastra" },
        "2026-04",
      ),
    ).not.toBeNull();
  });
});
