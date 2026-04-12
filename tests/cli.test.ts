import { describe, it, expect } from "vitest";
import { runCli, HELP_TEXT } from "../src/cli";

function fakeArgv(...args: string[]): string[] {
  return ["node", "scripts/run-audit.ts", ...args];
}

describe("runCli", () => {
  it("prints help when --help is passed", () => {
    const result = runCli(fakeArgv("--help"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("使用方法");
    expect(result.stdout).toContain("--help");
    expect(result.stderr).toBe("");
  });

  it("also accepts the -h short flag", () => {
    const result = runCli(fakeArgv("-h"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(HELP_TEXT);
  });

  it("prints help when no args are given", () => {
    const result = runCli(fakeArgv());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(HELP_TEXT);
  });

  it("returns non-zero exit code for unknown options", () => {
    const result = runCli(fakeArgv("--unknown"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未対応のオプション");
    expect(result.stdout).toBe("");
  });
});
