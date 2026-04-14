import { describe, it, expect, vi } from "vitest";
import { createAgent, fakeModel, tool } from "langchain";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";

import {
  validateGithubRepoArgs,
  createValidateToolArgsMiddleware,
  DEFAULT_TOOL_VALIDATORS,
  type ToolArgValidator,
} from "../../src/middleware/validate";

/**
 * spec-008 Implementation Step 3: ツール引数バリデーション middleware の契約テスト。
 *
 * **テスト層**:
 *   1. pure `validateGithubRepoArgs`: 合法 / null / missing / 型不一致 / regex NG /
 *      trailing-hyphen / repo 先頭ドット等、11 ケース
 *   2. middleware factory: 合法 → pass-through / 不正 → ToolMessage 返却 +
 *      handler 未呼び出し / 非登録ツール → pass-through / custom validators
 *   3. exports 契約: `DEFAULT_TOOL_VALIDATORS` が `fetch_github` のみ含む
 */

describe("validateGithubRepoArgs (pure)", () => {
  it("accepts a legitimate GitHub owner/repo pair", () => {
    expect(validateGithubRepoArgs({ owner: "mastra-ai", repo: "mastra" })).toEqual({
      ok: true,
    });
  });

  it("accepts alphanumeric and common punctuation in repo names", () => {
    expect(
      validateGithubRepoArgs({ owner: "foo", repo: "bar.baz_qux-42" }),
    ).toEqual({ ok: true });
  });

  it("rejects null args", () => {
    const result = validateGithubRepoArgs(null);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("non-null object");
  });

  it("rejects non-object args (e.g. string)", () => {
    const result = validateGithubRepoArgs("not an object");
    expect(result.ok).toBe(false);
  });

  it("rejects missing owner", () => {
    const result = validateGithubRepoArgs({ repo: "mastra" });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("owner must be a string");
  });

  it("rejects owner with invalid characters (space)", () => {
    const result = validateGithubRepoArgs({ owner: "foo bar", repo: "mastra" });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("does not match");
  });

  it("rejects owner with leading hyphen", () => {
    const result = validateGithubRepoArgs({ owner: "-foo", repo: "mastra" });
    expect(result.ok).toBe(false);
  });

  it("rejects owner with trailing hyphen (load-bearing beyond the regex)", () => {
    // GITHUB_OWNER_RE の character class `[A-Za-z0-9-]` は末尾ハイフンを許容して
    // しまうので、追加の endsWith チェックが必要になる。この挙動を確実に固定する。
    const result = validateGithubRepoArgs({ owner: "foo-", repo: "mastra" });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("must not end with a hyphen");
  });

  it("rejects owner longer than 39 characters", () => {
    const tooLong = "a".repeat(40);
    const result = validateGithubRepoArgs({ owner: tooLong, repo: "mastra" });
    expect(result.ok).toBe(false);
  });

  it("rejects missing repo", () => {
    const result = validateGithubRepoArgs({ owner: "foo" });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("repo must be a string");
  });

  it("rejects repo with leading dot (regex excludes leading `.`)", () => {
    const result = validateGithubRepoArgs({ owner: "foo", repo: ".hidden" });
    expect(result.ok).toBe(false);
  });

  it("rejects repo with path traversal sequences", () => {
    const result = validateGithubRepoArgs({ owner: "foo", repo: "../etc/passwd" });
    expect(result.ok).toBe(false);
  });

  it("rejects repo with spaces", () => {
    const result = validateGithubRepoArgs({ owner: "foo", repo: "my repo" });
    expect(result.ok).toBe(false);
  });
});

/**
 * Middleware factory E2E: fakeModel + dummy tool + createValidateToolArgsMiddleware。
 * logging.test.ts と同じ minimal createAgent パターンを流用する。
 */
const PROBE_TOOL_NAME = "fetch_github";

function makeScriptedModel(probeArgs: Record<string, unknown>) {
  let issued = 0;
  return fakeModel().respond((messages: BaseMessage[]) => {
    const last = messages[messages.length - 1];
    if (last && ToolMessage.isInstance(last)) {
      return new AIMessage("done");
    }
    issued += 1;
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          name: PROBE_TOOL_NAME,
          args: probeArgs,
          id: `tc-${issued}`,
          type: "tool_call",
        },
      ],
    });
  });
}

describe("createValidateToolArgsMiddleware (E2E with fakeModel + dummy tool)", () => {
  it("passes through when args are valid (handler is called)", async () => {
    const handlerSpy = vi.fn(
      async ({ owner, repo }: { owner: string; repo: string }) =>
        `${owner}/${repo}:ok`,
    );
    const probeTool = tool(handlerSpy, {
      name: PROBE_TOOL_NAME,
      description: "stub fetch_github",
      schema: z.object({ owner: z.string(), repo: z.string() }),
    });

    const agent = createAgent({
      model: makeScriptedModel({ owner: "mastra-ai", repo: "mastra" }),
      tools: [probeTool],
      systemPrompt: "x",
      middleware: [createValidateToolArgsMiddleware()],
    });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects with a ToolMessage (without calling the handler) when args are invalid", async () => {
    const handlerSpy = vi.fn(
      async ({ owner, repo }: { owner: string; repo: string }) =>
        `${owner}/${repo}:should-not-run`,
    );
    const probeTool = tool(handlerSpy, {
      name: PROBE_TOOL_NAME,
      // 注意: schema は `string().min(1)` なので "foo bar" は zod を通る。
      // middleware 側の regex で弾く挙動を検証したい。
      description: "stub fetch_github",
      schema: z.object({ owner: z.string().min(1), repo: z.string().min(1) }),
    });

    const capturedMessages: BaseMessage[] = [];
    const model = fakeModel().respond((messages: BaseMessage[]) => {
      capturedMessages.push(...messages);
      const last = messages[messages.length - 1];
      if (last && ToolMessage.isInstance(last)) {
        // ToolMessage (validation rejection) を受け取ったら完了する
        return new AIMessage("acknowledged validation error");
      }
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            name: PROBE_TOOL_NAME,
            args: { owner: "foo bar", repo: "mastra" }, // 空白 → regex NG
            id: "tc-1",
            type: "tool_call",
          },
        ],
      });
    });

    const agent = createAgent({
      model,
      tools: [probeTool],
      systemPrompt: "x",
      middleware: [createValidateToolArgsMiddleware()],
    });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });

    // handler は 1 度も呼ばれない
    expect(handlerSpy).not.toHaveBeenCalled();
    // model に届いた最終メッセージ列の中に、validate が返した ToolMessage が含まれる
    const toolMessages = capturedMessages.filter(
      (m) => m._getType() === "tool",
    ) as ToolMessage[];
    const rejected = toolMessages.find((m) => {
      const content = typeof m.content === "string" ? m.content : "";
      return content.includes("[validate]") && content.includes("rejected");
    });
    expect(rejected).toBeDefined();
    const rejectedContent =
      typeof rejected?.content === "string" ? rejected.content : "";
    expect(rejectedContent).toContain(PROBE_TOOL_NAME);
    expect(rejectedContent).toContain("does not match");
  });

  it("passes through tools that have no registered validator", async () => {
    // "other_tool" は DEFAULT_TOOL_VALIDATORS に無い。middleware はそのまま handler を
    // 呼び出すべき。
    const handlerSpy = vi.fn(async () => "other result");
    const otherTool = tool(handlerSpy, {
      name: "other_tool",
      description: "not validated",
      schema: z.object({}),
    });

    let issued = 0;
    const model = fakeModel().respond((messages: BaseMessage[]) => {
      const last = messages[messages.length - 1];
      if (last && ToolMessage.isInstance(last)) return new AIMessage("done");
      issued += 1;
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "other_tool",
            args: {},
            id: `tc-${issued}`,
            type: "tool_call",
          },
        ],
      });
    });

    const agent = createAgent({
      model,
      tools: [otherTool],
      systemPrompt: "x",
      middleware: [createValidateToolArgsMiddleware()],
    });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it("respects a custom validators map (override default)", async () => {
    // Custom validator: always rejects with a distinctive message.
    const alwaysReject: ToolArgValidator = () => ({
      ok: false,
      error: "denied by custom validator",
    });
    const handlerSpy = vi.fn(async () => "should not run");
    const probeTool = tool(handlerSpy, {
      name: "my_tool",
      description: "gated by custom validator",
      schema: z.object({}),
    });

    const capturedMessages: BaseMessage[] = [];
    const model = fakeModel().respond((messages: BaseMessage[]) => {
      capturedMessages.push(...messages);
      const last = messages[messages.length - 1];
      if (last && ToolMessage.isInstance(last)) return new AIMessage("done");
      return new AIMessage({
        content: "",
        tool_calls: [
          { name: "my_tool", args: {}, id: "tc-1", type: "tool_call" },
        ],
      });
    });

    const agent = createAgent({
      model,
      tools: [probeTool],
      systemPrompt: "x",
      middleware: [
        createValidateToolArgsMiddleware({
          validators: { my_tool: alwaysReject },
        }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });
    expect(handlerSpy).not.toHaveBeenCalled();
    const toolMessages = capturedMessages.filter(
      (m) => m._getType() === "tool",
    ) as ToolMessage[];
    const rejected = toolMessages.find((m) => {
      const content = typeof m.content === "string" ? m.content : "";
      return content.includes("denied by custom validator");
    });
    expect(rejected).toBeDefined();
  });
});

describe("exports contract", () => {
  it("DEFAULT_TOOL_VALIDATORS includes fetch_github and nothing else", () => {
    expect(Object.keys(DEFAULT_TOOL_VALIDATORS)).toEqual(["fetch_github"]);
  });

  it("DEFAULT_TOOL_VALIDATORS.fetch_github is validateGithubRepoArgs", () => {
    expect(DEFAULT_TOOL_VALIDATORS.fetch_github).toBe(validateGithubRepoArgs);
  });
});
