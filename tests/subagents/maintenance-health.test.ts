import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createMaintenanceHealthSubAgent } from "../../src/subagents/maintenance-health";

function fakeTool(name: string) {
  return tool(
    vi.fn(async () => "ok"),
    { name, description: `fake ${name}`, schema: z.object({}) },
  );
}

describe("createMaintenanceHealthSubAgent", () => {
  it("satisfies the deepagents SubAgent required fields", () => {
    const subagent = createMaintenanceHealthSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.name).toBe("maintenance-health");
    expect(subagent.description).toContain("メンテナンス");
    expect(subagent.systemPrompt).toContain("pushed_at");
  });

  it("instructs the subagent to write raw data under /raw/maintenance/", () => {
    const subagent = createMaintenanceHealthSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.systemPrompt).toContain("/raw/maintenance/result.json");
  });

  it("accepts injected tools without falling back to defaults", () => {
    const custom = fakeTool("custom_stub");
    const subagent = createMaintenanceHealthSubAgent({ tools: [custom] });
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("custom_stub");
  });

  it("falls back to the default fetch_github tool when no tools are injected", () => {
    const subagent = createMaintenanceHealthSubAgent();
    expect(subagent.tools).toHaveLength(1);
    expect(subagent.tools?.[0]?.name).toBe("fetch_github");
  });

  it("documents the healthy/warning/stale thresholds in the system prompt", () => {
    const subagent = createMaintenanceHealthSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.systemPrompt).toMatch(/healthy.*warning.*stale/s);
  });
});
