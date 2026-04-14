import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createCommunityAdoptionSubAgent,
  DEFAULT_COMMUNITY_ADOPTION_SKILLS,
} from "../../src/subagents/community-adoption";

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

  // spec-007: skill 配線の粒度検証。
  it("assigns exactly the community skill source by default (progressive disclosure scope)", () => {
    const subagent = createCommunityAdoptionSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.skills).toEqual([...DEFAULT_COMMUNITY_ADOPTION_SKILLS]);
    expect(DEFAULT_COMMUNITY_ADOPTION_SKILLS).toEqual(["/skills/audit/community/"]);
  });

  it("accepts a custom skills array that overrides the default", () => {
    const subagent = createCommunityAdoptionSubAgent({
      tools: [fakeTool("fetch_github")],
      skills: ["/skills/audit/custom/"],
    });
    expect(subagent.skills).toEqual(["/skills/audit/custom/"]);
  });
});
