import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createCommunityAdoptionSubAgent } from "../../src/subagents/community-adoption";

function fakeTool(name: string) {
  return tool(
    vi.fn(async () => "ok"),
    { name, description: `fake ${name}`, schema: z.object({}) },
  );
}

describe("createCommunityAdoptionSubAgent", () => {
  it("satisfies the deepagents SubAgent required fields", () => {
    const subagent = createCommunityAdoptionSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.name).toBe("community-adoption");
    expect(subagent.description).toContain("コミュニティ");
    expect(subagent.systemPrompt).toContain("stargazers_count");
  });

  it("instructs the subagent to write raw data under /raw/community/", () => {
    const subagent = createCommunityAdoptionSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.systemPrompt).toContain("/raw/community/result.json");
  });

  it("accepts injected tools without falling back to defaults", () => {
    const custom = fakeTool("custom_stub");
    const subagent = createCommunityAdoptionSubAgent({ tools: [custom] });
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("custom_stub");
  });

  it("falls back to the default fetch_github tool when no tools are injected", () => {
    const subagent = createCommunityAdoptionSubAgent();
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("fetch_github");
  });

  it("documents the adoption tier scale in the system prompt", () => {
    const subagent = createCommunityAdoptionSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.systemPrompt).toMatch(/niche|rising|popular|mainstream/);
  });
});
