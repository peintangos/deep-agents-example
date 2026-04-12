import { describe, it, expect, vi } from "vitest";
import { runCli, HELP_TEXT, type AgentInvoker } from "../src/cli";

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
});
