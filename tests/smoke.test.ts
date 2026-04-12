import { describe, it, expect } from "vitest";
import { createAuditAgent, DEFAULT_MODEL } from "../src/agent.js";

describe("deepagents smoke test", () => {
  it("exports a stable default model identifier", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-4-5-20250929");
  });

  it("creates a deep agent without throwing", () => {
    const agent = createAuditAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
  });
});
