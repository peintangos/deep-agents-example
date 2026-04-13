import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createApiStabilitySubAgent } from "../../src/subagents/api-stability";

function fakeTool(name: string) {
  return tool(
    vi.fn(async () => "ok"),
    { name, description: `fake ${name}`, schema: z.object({}) },
  );
}

describe("createApiStabilitySubAgent", () => {
  it("satisfies the deepagents SubAgent required fields", () => {
    const subagent = createApiStabilitySubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.name).toBe("api-stability");
    expect(subagent.description).toContain("API");
    expect(subagent.systemPrompt).toContain("SemVer");
  });

  it("instructs the subagent to write raw data under /raw/api-stability/", () => {
    const subagent = createApiStabilitySubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.systemPrompt).toContain("/raw/api-stability/result.json");
  });

  it("accepts injected tools without falling back to defaults", () => {
    const custom = fakeTool("custom_stub");
    const subagent = createApiStabilitySubAgent({ tools: [custom] });
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("custom_stub");
  });

  it("falls back to the default fetch_github tool when no tools are injected", () => {
    const subagent = createApiStabilitySubAgent();
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("fetch_github");
  });

  it("documents the stability categorization in the system prompt", () => {
    const subagent = createApiStabilitySubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.systemPrompt).toMatch(/stable|maturing|unstable/);
  });
});
