import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createAuditAgent,
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
});
