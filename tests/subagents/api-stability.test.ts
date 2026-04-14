import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createApiStabilitySubAgent,
  DEFAULT_API_STABILITY_SKILLS,
} from "../../src/subagents/api-stability";

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

  // spec-007: skill 配線の粒度検証。
  it("assigns exactly the api-stability skill source by default (progressive disclosure scope)", () => {
    const subagent = createApiStabilitySubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.skills).toEqual([...DEFAULT_API_STABILITY_SKILLS]);
    expect(DEFAULT_API_STABILITY_SKILLS).toEqual(["/skills/audit/api-stability/"]);
  });

  it("accepts a custom skills array that overrides the default", () => {
    const subagent = createApiStabilitySubAgent({
      tools: [fakeTool("fetch_github")],
      skills: ["/skills/audit/custom/"],
    });
    expect(subagent.skills).toEqual(["/skills/audit/custom/"]);
  });
});
