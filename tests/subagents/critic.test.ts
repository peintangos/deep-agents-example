import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createCriticSubAgent } from "../../src/subagents/critic";

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
});
