import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createLicenseAnalyzerSubAgent } from "../../src/subagents/license-analyzer";

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

describe("createLicenseAnalyzerSubAgent", () => {
  it("satisfies the deepagents SubAgent required fields", () => {
    const subagent = createLicenseAnalyzerSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.name).toBe("license-analyzer");
    expect(subagent.description).toContain("ライセンス");
    expect(subagent.systemPrompt).toContain("ライセンス");
  });

  it("instructs the subagent to write raw data under /raw/license/", () => {
    const subagent = createLicenseAnalyzerSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.systemPrompt).toContain("/raw/license/result.json");
  });

  it("accepts injected tools without falling back to defaults", () => {
    const customTool = fakeTool("custom_stub");
    const subagent = createLicenseAnalyzerSubAgent({ tools: [customTool] });
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("custom_stub");
  });

  it("falls back to the default fetch_github tool when no tools are injected", () => {
    const subagent = createLicenseAnalyzerSubAgent();
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("fetch_github");
  });

  it("documents the fact-only principle in the system prompt", () => {
    const subagent = createLicenseAnalyzerSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.systemPrompt).toMatch(/ファクト|推測は避/);
  });
});
