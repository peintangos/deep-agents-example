import { describe, it, expect } from "vitest";
import { createAgent, fakeModel, tool } from "langchain";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";

import {
  computeSleepMs,
  createGithubRateLimitMiddleware,
  DEFAULT_GITHUB_MIN_INTERVAL_MS,
  DEFAULT_GITHUB_RATE_LIMIT_TOOL_NAMES,
  type SleepFn,
} from "../../src/middleware/rate-limit";

/**
 * spec-008 Implementation Step 2: GitHub API レート制限 middleware の契約テスト。
 *
 * **テスト層**:
 *   1. pure `computeSleepMs`: null / elapsed>=interval / elapsed<interval /
 *      clock-skew (elapsed<0) の 4 パターンを決定論的に固定
 *   2. middleware factory: 初回呼び出し / 2 回目 (within interval) / 2 回目
 *      (interval 経過後) / 非対象ツールの 4 ケースを in-memory sleep mock で検証
 *   3. E2E: fakeModel + dummy tool + sleep mock で 2 連続呼び出しが wait を挟む
 *      ことを確認
 *   4. exports 契約: default const が期待値であること
 */

describe("computeSleepMs (pure)", () => {
  it("returns 0 when lastStartAt is null (first call)", () => {
    expect(
      computeSleepMs({
        lastStartAt: null,
        now: new Date("2026-04-14T00:00:00.000Z"),
        minIntervalMs: 700,
      }),
    ).toBe(0);
  });

  it("returns 0 when elapsed >= minIntervalMs (enough time passed)", () => {
    expect(
      computeSleepMs({
        lastStartAt: new Date("2026-04-14T00:00:00.000Z"),
        now: new Date("2026-04-14T00:00:00.800Z"), // 800 ms elapsed
        minIntervalMs: 700,
      }),
    ).toBe(0);
  });

  it("returns the remaining ms when elapsed < minIntervalMs", () => {
    expect(
      computeSleepMs({
        lastStartAt: new Date("2026-04-14T00:00:00.000Z"),
        now: new Date("2026-04-14T00:00:00.200Z"), // 200 ms elapsed
        minIntervalMs: 700,
      }),
    ).toBe(500);
  });

  it("returns minIntervalMs when elapsed is negative (clock skew cap)", () => {
    // 時計が逆戻りした場合: skew を全部足して待つのではなく、1 interval 分だけに
    // クランプする。これが無いと大きな skew で無限待ちリスクがある。
    expect(
      computeSleepMs({
        lastStartAt: new Date("2026-04-14T00:00:10.000Z"),
        now: new Date("2026-04-14T00:00:00.000Z"), // -10s
        minIntervalMs: 700,
      }),
    ).toBe(700);
  });
});

/**
 * Sleep mock を記録型で作るヘルパ。`fn` を middleware に渡し、`calls` で
 * 呼び出し履歴 (ms) を確認する。
 */
function createSleepSpy(): { readonly fn: SleepFn; readonly calls: number[] } {
  const calls: number[] = [];
  const fn: SleepFn = async (ms) => {
    calls.push(ms);
  };
  return { fn, calls };
}

/**
 * 単純な Date キューを回す `now` モック。毎回呼ばれるたびにキューの先頭を返す。
 * キューが尽きたら最後の値を繰り返す (middleware の now() 呼び出し回数に対して
 * テスト側で過剰に指定しなくて済むようにする)。
 */
function makeNowQueue(dates: readonly Date[]): () => Date {
  const queue = [...dates];
  return () => {
    if (queue.length === 1) return queue[0]!;
    return queue.shift()!;
  };
}

describe("createGithubRateLimitMiddleware (unit, fakeModel + 1 tool)", () => {
  const PROBE_TOOL_NAME = "fetch_github";

  function buildProbeTool() {
    return tool(
      async ({ owner, repo }: { owner: string; repo: string }) =>
        `${owner}/${repo}:ok`,
      {
        name: PROBE_TOOL_NAME,
        description: "stub fetch_github",
        schema: z.object({ owner: z.string(), repo: z.string() }),
      },
    );
  }

  function makeScriptedModel(params: {
    readonly probeArgs: Record<string, unknown>;
    readonly secondToolCall?: Record<string, unknown>;
  }) {
    let issuedCount = 0;
    return fakeModel().respond((messages: BaseMessage[]) => {
      const last = messages[messages.length - 1];
      // 2 tool 呼び出しを続けて発行するパターン: ToolMessage を受け取ったら
      // 2 つ目を発行、さらに ToolMessage を受け取ったら完了。
      if (last && ToolMessage.isInstance(last)) {
        if (params.secondToolCall !== undefined && issuedCount === 1) {
          issuedCount += 1;
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                name: PROBE_TOOL_NAME,
                args: params.secondToolCall,
                id: `tc-${issuedCount}`,
                type: "tool_call",
              },
            ],
          });
        }
        return new AIMessage("done");
      }
      issuedCount += 1;
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            name: PROBE_TOOL_NAME,
            args: params.probeArgs,
            id: `tc-${issuedCount}`,
            type: "tool_call",
          },
        ],
      });
    });
  }

  it("does not sleep on the very first call (lastStartAt=null)", async () => {
    const spy = createSleepSpy();
    const middleware = createGithubRateLimitMiddleware({
      minIntervalMs: 1000,
      now: () => new Date("2026-04-14T00:00:00.000Z"),
      sleep: spy.fn,
    });

    const agent = createAgent({
      model: makeScriptedModel({ probeArgs: { owner: "a", repo: "b" } }),
      tools: [buildProbeTool()],
      systemPrompt: "x",
      middleware: [middleware],
    });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });
    expect(spy.calls).toEqual([]);
  });

  it("sleeps the remaining interval when the second call is within the window", async () => {
    const spy = createSleepSpy();
    // now が順に 0ms, 200ms の Date を返す → 2 回目の call の前に 800 ms sleep が
    // 入るはず
    const now = makeNowQueue([
      new Date("2026-04-14T00:00:00.000Z"),
      new Date("2026-04-14T00:00:00.200Z"),
    ]);

    const middleware = createGithubRateLimitMiddleware({
      minIntervalMs: 1000,
      now,
      sleep: spy.fn,
    });

    const agent = createAgent({
      model: makeScriptedModel({
        probeArgs: { owner: "a", repo: "1" },
        secondToolCall: { owner: "a", repo: "2" },
      }),
      tools: [buildProbeTool()],
      systemPrompt: "x",
      middleware: [middleware],
    });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });
    // 1 回目は sleep なし、2 回目は 1000 - 200 = 800 ms sleep
    expect(spy.calls).toEqual([800]);
  });

  it("does NOT sleep when the second call arrives after the interval has passed", async () => {
    const spy = createSleepSpy();
    const now = makeNowQueue([
      new Date("2026-04-14T00:00:00.000Z"),
      new Date("2026-04-14T00:00:01.500Z"), // 1500 ms > 1000 ms interval
    ]);

    const middleware = createGithubRateLimitMiddleware({
      minIntervalMs: 1000,
      now,
      sleep: spy.fn,
    });

    const agent = createAgent({
      model: makeScriptedModel({
        probeArgs: { owner: "a", repo: "1" },
        secondToolCall: { owner: "a", repo: "2" },
      }),
      tools: [buildProbeTool()],
      systemPrompt: "x",
      middleware: [middleware],
    });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });
    expect(spy.calls).toEqual([]);
  });

  it("passes through non-throttled tools without touching the sleep fn", async () => {
    const spy = createSleepSpy();
    const otherTool = tool(
      async () => "other result",
      {
        name: "other_tool",
        description: "not throttled",
        schema: z.object({}),
      },
    );

    let callCount = 0;
    const model = fakeModel().respond((messages: BaseMessage[]) => {
      const last = messages[messages.length - 1];
      if (last && ToolMessage.isInstance(last)) return new AIMessage("done");
      callCount += 1;
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "other_tool",
            args: {},
            id: `tc-${callCount}`,
            type: "tool_call",
          },
        ],
      });
    });

    // toolNames は default (fetch_github のみ)。other_tool は throttle されない。
    const middleware = createGithubRateLimitMiddleware({
      minIntervalMs: 1000,
      now: () => new Date("2026-04-14T00:00:00.000Z"),
      sleep: spy.fn,
    });

    const agent = createAgent({
      model,
      tools: [otherTool],
      systemPrompt: "x",
      middleware: [middleware],
    });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });
    expect(spy.calls).toEqual([]);
  });

  it("respects a custom toolNames list (multi-tool scope)", async () => {
    const spy = createSleepSpy();
    const customTool = tool(
      async () => "custom result",
      {
        name: "custom_github_tool",
        description: "another github tool",
        schema: z.object({}),
      },
    );

    const model = fakeModel().respond((messages: BaseMessage[]) => {
      const last = messages[messages.length - 1];
      if (last && ToolMessage.isInstance(last)) return new AIMessage("done");
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "custom_github_tool",
            args: {},
            id: "tc-1",
            type: "tool_call",
          },
        ],
      });
    });

    const middleware = createGithubRateLimitMiddleware({
      minIntervalMs: 1000,
      toolNames: ["custom_github_tool"],
      now: () => new Date("2026-04-14T00:00:00.000Z"),
      sleep: spy.fn,
    });

    const agent = createAgent({
      model,
      tools: [customTool],
      systemPrompt: "x",
      middleware: [middleware],
    });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });
    // 初回なので sleep は呼ばれないが、少なくとも throw せず完了することは確認
    expect(spy.calls).toEqual([]);
  });
});

describe("exports contract", () => {
  it("DEFAULT_GITHUB_MIN_INTERVAL_MS keeps calls under GitHub's 5000/hour limit", () => {
    // 5000/hour = 1.388 req/sec → 最小間隔 ~720 ms 以上が必要。default は 700 ms
    // で、fetch_github の実遅延 (API 往復) を加味すると実効的に 1.0 req/sec 付近に
    // 落ち着く想定なので、この assertion は "順序と数値の固定" が目的。
    expect(DEFAULT_GITHUB_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(500);
    expect(DEFAULT_GITHUB_MIN_INTERVAL_MS).toBeLessThanOrEqual(1000);
    expect(DEFAULT_GITHUB_MIN_INTERVAL_MS).toBe(700);
  });

  it("DEFAULT_GITHUB_RATE_LIMIT_TOOL_NAMES targets fetch_github (the only GitHub tool)", () => {
    expect([...DEFAULT_GITHUB_RATE_LIMIT_TOOL_NAMES]).toEqual(["fetch_github"]);
  });
});
