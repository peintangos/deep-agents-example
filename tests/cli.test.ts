import { describe, it, expect, vi } from "vitest";
import {
  runCli,
  HELP_TEXT,
  buildAuditPrompt,
  parseTargetArg,
  type AgentInvoker,
} from "../src/cli";

function fakeArgv(...args: string[]): string[] {
  return ["node", "scripts/run-audit.ts", ...args];
}

describe("runCli", () => {
  it("prints help when --help is passed", async () => {
    const result = await runCli(fakeArgv("--help"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("使用方法");
    expect(result.stdout).toContain("--help");
    expect(result.stdout).toContain("OPENROUTER_API_KEY");
    expect(result.stderr).toBe("");
  });

  it("also accepts the -h short flag", async () => {
    const result = await runCli(fakeArgv("-h"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(HELP_TEXT);
  });

  it("prints help when no args are given", async () => {
    const result = await runCli(fakeArgv());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(HELP_TEXT);
  });

  it("returns non-zero exit code for unknown options", async () => {
    const result = await runCli(fakeArgv("--unknown"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未対応のオプション");
    expect(result.stdout).toBe("");
  });

  describe("--invoke", () => {
    it("calls the injected invoker with the prompt and returns its output", async () => {
      const invoker: AgentInvoker = vi.fn(async (prompt: string) => `echo: ${prompt}`);
      const result = await runCli(fakeArgv("--invoke", "hello world"), { invoker });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("echo: hello world");
      expect(invoker).toHaveBeenCalledWith("hello world");
    });

    it("reports an error when the prompt is missing", async () => {
      const invoker: AgentInvoker = vi.fn();
      const result = await runCli(fakeArgv("--invoke"), { invoker });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("プロンプト文字列");
      expect(invoker).not.toHaveBeenCalled();
    });

    it("reports an error when no invoker is configured", async () => {
      const result = await runCli(fakeArgv("--invoke", "hi"));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("agent invoker is not configured");
    });

    it("surfaces invoker errors as stderr and exit code 1", async () => {
      const invoker: AgentInvoker = vi.fn(async () => {
        throw new Error("boom");
      });
      const result = await runCli(fakeArgv("--invoke", "hi"), { invoker });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("agent invocation failed: boom");
    });
  });

  describe("--target", () => {
    it("calls the invoker with an audit prompt built from owner/repo", async () => {
      const invoker: AgentInvoker = vi.fn(async (prompt: string) => `ran: ${prompt}`);
      const result = await runCli(fakeArgv("--target", "mastra-ai/mastra"), {
        invoker,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const receivedPrompt = (invoker as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(receivedPrompt).toBe(buildAuditPrompt("mastra-ai", "mastra"));
      expect(result.stdout).toContain("ran:");
      expect(result.stdout).toContain("mastra-ai/mastra");
    });

    it("reports an error when the target value is missing", async () => {
      const invoker: AgentInvoker = vi.fn();
      const result = await runCli(fakeArgv("--target"), { invoker });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("owner/repo 形式");
      expect(invoker).not.toHaveBeenCalled();
    });

    it("rejects a target that does not contain exactly one slash", async () => {
      const invoker: AgentInvoker = vi.fn();
      const resultNoSlash = await runCli(fakeArgv("--target", "mastra"), { invoker });
      expect(resultNoSlash.exitCode).toBe(1);
      expect(resultNoSlash.stderr).toContain('"owner/repo" 形式');

      const resultTwoSlashes = await runCli(
        fakeArgv("--target", "a/b/c"),
        { invoker },
      );
      expect(resultTwoSlashes.exitCode).toBe(1);
      expect(resultTwoSlashes.stderr).toContain('"owner/repo" 形式');

      expect(invoker).not.toHaveBeenCalled();
    });

    it("rejects a target whose owner violates GitHub naming rules", async () => {
      const invoker: AgentInvoker = vi.fn();
      // trailing hyphen — 既存の validateGithubRepoArgs が弾くケースを CLI 経由で確認
      const result = await runCli(fakeArgv("--target", "bad-/repo"), { invoker });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("owner");
      expect(invoker).not.toHaveBeenCalled();
    });

    it("rejects a target whose repo violates GitHub naming rules", async () => {
      const invoker: AgentInvoker = vi.fn();
      // 先頭ドット — GitHub の repo 名前規約違反
      const result = await runCli(fakeArgv("--target", "owner/.repo"), { invoker });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("repo");
      expect(invoker).not.toHaveBeenCalled();
    });

    it("errors when no invoker is configured", async () => {
      const result = await runCli(fakeArgv("--target", "mastra-ai/mastra"));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("agent invoker is not configured");
    });

    it("surfaces invoker errors as stderr and exit code 1", async () => {
      const invoker: AgentInvoker = vi.fn(async () => {
        throw new Error("boom");
      });
      const result = await runCli(fakeArgv("--target", "mastra-ai/mastra"), {
        invoker,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("agent invocation failed: boom");
    });

    it("is mutually exclusive with --invoke", async () => {
      const invoker: AgentInvoker = vi.fn();
      const result = await runCli(
        fakeArgv("--target", "mastra-ai/mastra", "--invoke", "hi"),
        { invoker },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--invoke と --target は同時に指定できません");
      expect(invoker).not.toHaveBeenCalled();
    });
  });
});

describe("parseTargetArg", () => {
  it("accepts a valid owner/repo pair", () => {
    const result = parseTargetArg("mastra-ai/mastra");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.owner).toBe("mastra-ai");
      expect(result.repo).toBe("mastra");
    }
  });

  it("rejects missing slash", () => {
    const result = parseTargetArg("mastra");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"owner/repo" 形式');
    }
  });

  it("rejects empty owner or repo half", () => {
    const emptyOwner = parseTargetArg("/mastra");
    const emptyRepo = parseTargetArg("mastra-ai/");
    expect(emptyOwner.ok).toBe(false);
    expect(emptyRepo.ok).toBe(false);
  });

  it("delegates semantic validation to validateGithubRepoArgs", () => {
    // 先頭ドットは CLI 層の形式チェックでは通るが、validator 層で弾かれる
    const result = parseTargetArg("owner/.hidden");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("repo");
    }
  });
});

describe("buildAuditPrompt", () => {
  it("mentions owner and repo in a single identifying block", () => {
    const prompt = buildAuditPrompt("mastra-ai", "mastra");
    expect(prompt).toContain("mastra-ai/mastra");
  });

  it("does not duplicate AUDIT_SYSTEM_PROMPT orchestration details", () => {
    // 監査手順 (Phase 0〜2 / 5 観点の具体的な JSON path 等) は system prompt に
    // 集約する設計。ユーザープロンプトが詳細を持つと drift するのでガード。
    const prompt = buildAuditPrompt("a", "b");
    expect(prompt).not.toContain("/raw/license/result.json");
    expect(prompt).not.toContain("/raw/critic/findings.json");
    expect(prompt).not.toContain("license-analyzer");
  });
});
