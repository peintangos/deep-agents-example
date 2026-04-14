import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createLicenseAnalyzerSubAgent,
  DEFAULT_LICENSE_ANALYZER_SKILLS,
} from "../../src/subagents/license-analyzer";

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

  // spec-007: skill 配線の粒度検証。license-analyzer は audit カテゴリ全体 (5 aspects)
  // の metadata を受け取るが、report カテゴリは受け取らない (filter 境界が
  // "audit vs report")。観点単独パス (例 `/skills/audit/license/`) は
  // deepagents v1.9 の listSkillsFromBackend が 1 階層のサブディレクトリ走査しか
  // サポートしないため使えず、0 skill しか返らない — spec-007 のテスト実装時に
  // 検出した制約。実質的な "license 観点だけを読む" ロジックは LLM の description
  // マッチ + 段階的開示で実現する (本文は必要時のみ read_file される)。
  it("assigns /skills/audit/ as source by default (audit-scope progressive disclosure)", () => {
    const subagent = createLicenseAnalyzerSubAgent({ tools: [fakeTool("fetch_github")] });
    expect(subagent.skills).toEqual([...DEFAULT_LICENSE_ANALYZER_SKILLS]);
    expect(DEFAULT_LICENSE_ANALYZER_SKILLS).toEqual(["/skills/audit/"]);
    // report 系は流れないことを明示 (subagent/main の主たる filter 境界)。
    expect([...DEFAULT_LICENSE_ANALYZER_SKILLS]).not.toContain("/skills/report/");
  });

  it("accepts a custom skills array that overrides the default", () => {
    const subagent = createLicenseAnalyzerSubAgent({
      tools: [fakeTool("fetch_github")],
      skills: ["/skills/audit/custom/"],
    });
    expect(subagent.skills).toEqual(["/skills/audit/custom/"]);
  });
});
