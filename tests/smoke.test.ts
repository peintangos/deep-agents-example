import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph-checkpoint";
import {
  createAuditAgent,
  DEFAULT_INTERRUPT_ON,
  DEFAULT_MODEL_NAME,
  OPENROUTER_BASE_URL,
  AUDIT_SYSTEM_PROMPT,
} from "../src/agent";

describe("deepagents smoke test", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    // ChatOpenAI のコンストラクタは API キーが無いと実 API 呼び出し前に fail する
    // 可能性があるため、テスト用のダミーキーを注入しておく。実 API 呼び出しはしない。
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it("exports the OpenRouter + GPT-4.1 configuration", () => {
    expect(DEFAULT_MODEL_NAME).toBe("openai/gpt-4.1");
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("creates a deep agent without throwing (requires dummy API key)", () => {
    const agent = createAuditAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
  });

  it("throws a helpful error when OPENROUTER_API_KEY is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => createAuditAgent()).toThrow(/OPENROUTER_API_KEY/);
  });

  it("throws when the API key still contains the placeholder marker", () => {
    process.env.OPENROUTER_API_KEY = "<paste-your-openrouter-api-key-here>";
    expect(() => createAuditAgent()).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("AUDIT_SYSTEM_PROMPT orchestration structure", () => {
  it("names all 6 sub agents so the orchestrator can delegate via task", () => {
    expect(AUDIT_SYSTEM_PROMPT).toContain("license-analyzer");
    expect(AUDIT_SYSTEM_PROMPT).toContain("security-auditor");
    expect(AUDIT_SYSTEM_PROMPT).toContain("maintenance-health");
    expect(AUDIT_SYSTEM_PROMPT).toContain("api-stability");
    expect(AUDIT_SYSTEM_PROMPT).toContain("community-adoption");
    expect(AUDIT_SYSTEM_PROMPT).toContain("critic");
  });

  it("describes the 2-phase ordering (audit before critic)", () => {
    const auditPhaseIdx = AUDIT_SYSTEM_PROMPT.indexOf("Phase 1");
    const criticPhaseIdx = AUDIT_SYSTEM_PROMPT.indexOf("Phase 2");
    expect(auditPhaseIdx).toBeGreaterThan(-1);
    expect(criticPhaseIdx).toBeGreaterThan(auditPhaseIdx);
    expect(AUDIT_SYSTEM_PROMPT).toMatch(
      /Phase 1 が終わる前に\s*\n?\s*critic を呼んではいけません/,
    );
  });

  it("lists all 6 completion-condition raw paths", () => {
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/license/result.json");
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/security/result.json");
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/maintenance/result.json");
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/api-stability/result.json");
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/community/result.json");
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/critic/findings.json");
  });

  it("tells the agent not to build the final Markdown itself (reporter does)", () => {
    expect(AUDIT_SYSTEM_PROMPT).toContain("src/reporter.ts");
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/Markdown を\s*\n?\s*組み立てません/);
  });

  it("documents the fact-only principle", () => {
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/ファクト|推測/);
  });

  it("instructs the agent to consult prior history at /memories/history/<owner>-<repo>-<yyyy-mm>.json", () => {
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/Phase 0/);
    expect(AUDIT_SYSTEM_PROMPT).toContain(
      "/memories/history/<owner>-<repo>-<yyyy-mm>.json",
    );
  });

  it("tells the agent to continue the audit even when no prior history exists", () => {
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/履歴.*存在しなくても.*続行/s);
  });

  it("declares that history file writes are NOT the agent's responsibility (orchestrator owns it)", () => {
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/書き込み.*エージェントの責務ではありません/s);
  });

  it("orders Phase 0 before Phase 1 so prior history is consulted first", () => {
    const phase0Idx = AUDIT_SYSTEM_PROMPT.indexOf("Phase 0");
    const phase1Idx = AUDIT_SYSTEM_PROMPT.indexOf("Phase 1");
    expect(phase0Idx).toBeGreaterThan(-1);
    expect(phase1Idx).toBeGreaterThan(phase0Idx);
  });
});

describe("createAuditAgent store injection (spec-005)", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it("creates an agent without throwing when a custom InMemoryStore is injected", () => {
    const store = new InMemoryStore();
    const agent = createAuditAgent({ store });
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
  });

  it("creates a default InMemoryStore when no store option is passed", () => {
    const agent = createAuditAgent();
    expect(agent).toBeDefined();
  });

  it("allows two agents to share the same store for cross-session /memories/ persistence", () => {
    const sharedStore = new InMemoryStore();
    const agentA = createAuditAgent({ store: sharedStore });
    const agentB = createAuditAgent({ store: sharedStore });
    expect(agentA).toBeDefined();
    expect(agentB).toBeDefined();
    // The actual cross-agent read/write behavior is exercised by the
    // spec-005 integration test that persists data via /memories/ paths.
    // Here we only assert the wiring constructs two valid agents over the
    // same BaseStore instance without throwing.
  });

  it("can persist and retrieve data directly through the injected store (store-level proof)", async () => {
    const store = new InMemoryStore();
    createAuditAgent({ store });

    // deepagents の StoreBackend は `/memories/` 配下の書き込みを LangGraph store に
    // 流すが、その namespace は deepagents 内部で管理されている。ここではその
    // namespace を通さず、store API を直接叩くことで「注入された store が
    // 書き込み可能な生きたインスタンスである」最低限の証跡を残す。
    await store.put(["test-namespace"], "key1", { hello: "world" });
    const item = await store.get(["test-namespace"], "key1");
    expect(item?.value).toEqual({ hello: "world" });
  });
});

describe("createAuditAgent HITL wiring (spec-006)", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it("creates an agent with an injected checkpointer without throwing", () => {
    const checkpointer = new MemorySaver();
    const agent = createAuditAgent({ checkpointer });
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
  });

  it("creates a default MemorySaver when no checkpointer option is passed", () => {
    // interruptOn をデフォルト (= HITL 有効) のまま、checkpointer 省略で agent が
    // 生成できることを検証する。checkpointer が無いと HITL middleware が
    // state を保てず実行時に落ちるが、デフォルトで MemorySaver が注入されて
    // いれば生成時点では throw しない。
    const agent = createAuditAgent();
    expect(agent).toBeDefined();
  });

  it("accepts a custom interruptOn map for tests that want to disable HITL", () => {
    // interruptOn: {} を渡すと実質 HITL 無効。HITL を使わないサブエージェント単体
    // テストや future spec で「配線だけ残して中断は止めたい」ケースで使う。
    const agent = createAuditAgent({ interruptOn: {} });
    expect(agent).toBeDefined();
  });

  it("exposes DEFAULT_INTERRUPT_ON with exactly the two external-API tools", () => {
    expect(Object.keys(DEFAULT_INTERRUPT_ON).sort()).toEqual([
      "fetch_github",
      "query_osv",
    ]);
  });

  it("does NOT include write_file in DEFAULT_INTERRUPT_ON (would block /raw/ writes)", () => {
    // write_file を中断対象に含めると、各サブエージェントが /raw/<aspect>/result.json
    // を書こうとするたびに中断がかかり、監査が事実上進まなくなる。将来 write_file
    // の中断が必要になったときは「パス引数でフィルタする description factory」を
    // 用意するなど別戦略が必要 — ここでの選択が将来のトリガーになるよう明示する。
    expect(DEFAULT_INTERRUPT_ON).not.toHaveProperty("write_file");
    expect(DEFAULT_INTERRUPT_ON).not.toHaveProperty("read_file");
  });

  it("configures each HITL tool with approve/reject decisions and a Japanese description", () => {
    for (const [toolName, config] of Object.entries(DEFAULT_INTERRUPT_ON)) {
      expect(config.allowedDecisions).toEqual(["approve", "reject"]);
      expect(typeof config.description).toBe("string");
      // 日本語 (CJK 文字) を含むこと。description に英文が紛れ込むのを防ぐ。
      expect(config.description as string).toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
      expect(toolName).toMatch(/^(fetch_github|query_osv)$/);
    }
  });
});
