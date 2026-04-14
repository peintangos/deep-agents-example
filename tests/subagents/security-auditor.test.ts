import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createSecurityAuditorSubAgent,
  DEFAULT_SECURITY_AUDITOR_SKILLS,
} from "../../src/subagents/security-auditor";

function fakeTool(name: string) {
  return tool(
    vi.fn(async () => "ok"),
    { name, description: `fake ${name}`, schema: z.object({}) },
  );
}

describe("createSecurityAuditorSubAgent", () => {
  it("satisfies the deepagents SubAgent required fields", () => {
    const subagent = createSecurityAuditorSubAgent({ tools: [fakeTool("query_osv")] });
    expect(subagent.name).toBe("security-auditor");
    expect(subagent.description).toContain("脆弱性");
    expect(subagent.systemPrompt).toContain("OSV");
  });

  it("instructs the subagent to write raw data under /raw/security/", () => {
    const subagent = createSecurityAuditorSubAgent({ tools: [fakeTool("query_osv")] });
    expect(subagent.systemPrompt).toContain("/raw/security/result.json");
  });

  it("accepts injected tools without falling back to defaults", () => {
    const custom = fakeTool("custom_stub");
    const subagent = createSecurityAuditorSubAgent({ tools: [custom] });
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("custom_stub");
  });

  it("falls back to the default query_osv tool when no tools are injected", () => {
    const subagent = createSecurityAuditorSubAgent();
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("query_osv");
  });

  it("documents severity categorization in the system prompt", () => {
    const subagent = createSecurityAuditorSubAgent({ tools: [fakeTool("query_osv")] });
    expect(subagent.systemPrompt).toMatch(/CRITICAL|HIGH|MEDIUM|LOW/);
  });

  // spec-007: skill 配線の粒度検証。audit カテゴリ全体を読み、report は読まない。
  // 観点単独パスは listSkillsFromBackend の 1 階層走査制限で使えない
  // (license-analyzer.test.ts の解説参照)。
  it("assigns /skills/audit/ as source by default (audit-scope progressive disclosure)", () => {
    const subagent = createSecurityAuditorSubAgent({ tools: [fakeTool("query_osv")] });
    expect(subagent.skills).toEqual([...DEFAULT_SECURITY_AUDITOR_SKILLS]);
    expect(DEFAULT_SECURITY_AUDITOR_SKILLS).toEqual(["/skills/audit/"]);
    expect([...DEFAULT_SECURITY_AUDITOR_SKILLS]).not.toContain("/skills/report/");
  });

  it("accepts a custom skills array that overrides the default", () => {
    const subagent = createSecurityAuditorSubAgent({
      tools: [fakeTool("query_osv")],
      skills: ["/skills/audit/custom/"],
    });
    expect(subagent.skills).toEqual(["/skills/audit/custom/"]);
  });
});
