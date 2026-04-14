import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createCriticSubAgent,
  DEFAULT_CRITIC_SKILLS,
} from "../../src/subagents/critic";

function fakeTool(name: string) {
  return tool(
    vi.fn(async () => "ok"),
    {
      name,
      description: `fake ${name}`,
      schema: z.object({}),
    },
  );
}

describe("createCriticSubAgent", () => {
  it("satisfies the deepagents SubAgent required fields", () => {
    const subagent = createCriticSubAgent();
    expect(subagent.name).toBe("critic");
    expect(subagent.description).toContain("整合性");
    expect(subagent.systemPrompt).toContain("critic");
  });

  it("references all 5 audit aspect raw paths in the system prompt", () => {
    const subagent = createCriticSubAgent();
    expect(subagent.systemPrompt).toContain("/raw/license/result.json");
    expect(subagent.systemPrompt).toContain("/raw/security/result.json");
    expect(subagent.systemPrompt).toContain("/raw/maintenance/result.json");
    expect(subagent.systemPrompt).toContain("/raw/api-stability/result.json");
    expect(subagent.systemPrompt).toContain("/raw/community/result.json");
  });

  it("instructs the subagent to write findings to /raw/critic/findings.json", () => {
    const subagent = createCriticSubAgent();
    expect(subagent.systemPrompt).toContain("/raw/critic/findings.json");
  });

  it("documents the overall_assessment enum and severity levels", () => {
    const subagent = createCriticSubAgent();
    expect(subagent.systemPrompt).toContain("overall_assessment");
    expect(subagent.systemPrompt).toContain("critical");
    expect(subagent.systemPrompt).toContain("warning");
    expect(subagent.systemPrompt).toContain("info");
    expect(subagent.systemPrompt).toContain("pass");
    expect(subagent.systemPrompt).toContain("blocked");
  });

  it("documents the fact-only principle in the system prompt", () => {
    const subagent = createCriticSubAgent();
    expect(subagent.systemPrompt).toMatch(/ファクト|推測/);
  });

  it("does not attach custom tools by default so that deepagents default file tools are used", () => {
    const subagent = createCriticSubAgent();
    expect(subagent.tools).toBeUndefined();
  });

  it("accepts injected tools when explicitly provided (for future extensibility)", () => {
    const customTool = fakeTool("custom_stub");
    const subagent = createCriticSubAgent({ tools: [customTool] });
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("custom_stub");
  });

  // spec-007: critic は 5 観点を横断で評価するため、例外的に `/skills/audit/` 全体を
  // scan する。他のサブエージェント (license/security/etc) は自観点の 1 ソースだけで、
  // メインは `/skills/audit/` + `/skills/report/` の 2 ソース。3 階層の粒度分布。
  it("assigns `/skills/audit/` as a whole (cross-aspect context) by default", () => {
    const subagent = createCriticSubAgent();
    expect(subagent.skills).toEqual([...DEFAULT_CRITIC_SKILLS]);
    expect(DEFAULT_CRITIC_SKILLS).toEqual(["/skills/audit/"]);
    // report skill はメイン側のみ。critic には流れない (監査結果の整合性検証が
    // 責務で、レポート文体は関知しないため)。
    expect([...DEFAULT_CRITIC_SKILLS]).not.toContain("/skills/report/");
  });

  it("accepts a custom skills array that overrides the default", () => {
    const subagent = createCriticSubAgent({
      skills: ["/skills/audit/consistency/"],
    });
    expect(subagent.skills).toEqual(["/skills/audit/consistency/"]);
  });
});
