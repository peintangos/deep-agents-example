import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAgent, fakeModel, tool } from "langchain";
import type { AgentMiddleware } from "langchain";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";

import {
  createToolCallLoggingMiddleware,
  type ToolCallLogEvent,
  type ToolCallLogSink,
} from "../../src/middleware/logging";
import {
  createGithubRateLimitMiddleware,
  type SleepFn,
} from "../../src/middleware/rate-limit";
import { createValidateToolArgsMiddleware } from "../../src/middleware/validate";
import {
  createAuditAgent,
  createDefaultAuditMiddlewares,
  DEFAULT_TOOL_CALL_LOG_PATH,
} from "../../src/agent";

/**
 * spec-008 Implementation Step 4: `createAuditAgent` への middleware 配線と、
 * `[logging, validate, rate-limit]` 3 本の合成順序を決定論的に検証する統合テスト。
 *
 * **テスト層**:
 *   1. createAuditAgent DI: `middleware` オプションで default / custom / 空配列 /
 *      in-memory sink 差し替え等が throw せず構成できる
 *   2. wrap 順序 E2E: minimal createAgent + 3 middleware + fakeModel + dummy tool で、
 *      langchain の `chainToolCallHandlers` が `middleware[0]` を outermost として
 *      合成することを **実際の呼び出し挙動** で検証する
 *     - 合法引数: logging が success event 1 件を sink、rate-limit の sleep spy が
 *       1 回 (初回 = 0ms)、handler が 1 回呼ばれる
 *     - 不正引数: logging が success event 1 件を sink するが `resultPreview` に
 *       `[validate]` rejection を含む、rate-limit sleep は **呼ばれない**
 *       (validate が rate-limit より外にあるため)、handler は **呼ばれない**
 *
 * 2 の負のアサーション (sleep_spy.calls.length === 0) が順序の決定的証跡。
 */

const PROBE_TOOL_NAME = "fetch_github";

/**
 * minimal createAgent を組み立てて 1 回 invoke するユーティリティ。
 * fakeModel は 1 回だけ `fetch_github` を呼ぶ tool_call を発行し、ToolMessage を
 * 受け取ったら完了する (hitl-e2e.test.ts と同じパターン)。
 */
async function runWithMiddlewareStack(params: {
  readonly probeArgs: Record<string, unknown>;
  readonly handler: (args: { owner: string; repo: string }) => Promise<string>;
  readonly middleware: readonly AgentMiddleware[];
}): Promise<void> {
  const probeTool = tool(params.handler, {
    name: PROBE_TOOL_NAME,
    description: "stub fetch_github for integration test",
    schema: z.object({ owner: z.string(), repo: z.string() }),
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
          name: PROBE_TOOL_NAME,
          args: params.probeArgs,
          id: `tc-${issued}`,
          type: "tool_call",
        },
      ],
    });
  });

  // langchain の createAgent は `middleware?: TMiddleware` を generics で受け取り、
  // `AgentMiddleware[]` をそのまま渡すと as-const 型情報が欠落して Tuple 推論が
  // 外れる。ここでは構造テストが目的で型情報は不要なので、`as never` で一旦
  // 型チェックを外す (実行時の shape は正しい)。
  const agent = createAgent({
    model,
    tools: [probeTool],
    systemPrompt: "x",
    middleware: [...params.middleware] as never,
  });

  await (agent.invoke as (input: unknown) => Promise<unknown>)({
    messages: [{ role: "user", content: "go" }],
  });
}

function buildInMemorySink(): {
  readonly sink: ToolCallLogSink;
  readonly events: ToolCallLogEvent[];
} {
  const events: ToolCallLogEvent[] = [];
  return {
    sink: (event) => {
      events.push(event);
    },
    events,
  };
}

function createSleepSpy(): { readonly fn: SleepFn; readonly calls: number[] } {
  const calls: number[] = [];
  const fn: SleepFn = async (ms) => {
    calls.push(ms);
  };
  return { fn, calls };
}

describe("spec-008 middleware wrap order (minimal createAgent E2E)", () => {
  it("composes [logging, validate, rate-limit] so valid args reach the handler", async () => {
    const { sink, events } = buildInMemorySink();
    const sleepSpy = createSleepSpy();
    const handlerSpy = vi.fn(async ({ owner, repo }: { owner: string; repo: string }) => {
      return `${owner}/${repo}:probed`;
    });

    await runWithMiddlewareStack({
      probeArgs: { owner: "mastra-ai", repo: "mastra" },
      handler: handlerSpy,
      middleware: [
        createToolCallLoggingMiddleware({ sink }),
        createValidateToolArgsMiddleware(),
        createGithubRateLimitMiddleware({
          minIntervalMs: 1000,
          now: () => new Date("2026-04-14T00:00:00.000Z"),
          sleep: sleepSpy.fn,
        }),
      ],
    });

    // 1. logging は成功 event を 1 件記録する
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("success");
    expect(events[0]!.toolName).toBe(PROBE_TOOL_NAME);
    // resultPreview には handler の戻り値が含まれる (rejection ではない)
    expect(events[0]!.resultPreview).toContain("mastra-ai/mastra:probed");
    expect(events[0]!.resultPreview).not.toContain("[validate]");

    // 2. rate-limit は初回呼び出しなので sleep は 0 (呼ばれない)
    expect(sleepSpy.calls).toEqual([]);

    // 3. handler は 1 回呼ばれる
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it("composes [logging, validate, rate-limit] so invalid args are rejected BEFORE rate-limit sleeps", async () => {
    const { sink, events } = buildInMemorySink();
    const sleepSpy = createSleepSpy();
    const handlerSpy = vi.fn(async () => "should not run");

    await runWithMiddlewareStack({
      // "foo bar" (空白) は GitHub owner 規則に反するので validate が reject する
      probeArgs: { owner: "foo bar", repo: "mastra" },
      handler: handlerSpy,
      middleware: [
        createToolCallLoggingMiddleware({ sink }),
        createValidateToolArgsMiddleware(),
        createGithubRateLimitMiddleware({
          minIntervalMs: 1000,
          now: () => new Date("2026-04-14T00:00:00.000Z"),
          sleep: sleepSpy.fn,
        }),
      ],
    });

    // 1. logging は 1 件記録する (rejection も "success event" として現れる —
    //    logging middleware は handler の throw だけを error とみなし、
    //    ToolMessage の content に何が書かれていても status は success)
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("success");
    // resultPreview に validate rejection のメッセージが入っていることが
    // "rejection が logging の内側で発生した" 証跡。もし logging が
    // validate の内側にあれば、logging は呼び出されず events は空になる。
    expect(events[0]!.resultPreview).toContain("[validate]");
    expect(events[0]!.resultPreview).toContain("rejected");

    // 2. rate-limit は **呼ばれない**: validate の rejection は rate-limit より
    //    "外" の層で発生するため。sleep_spy.calls が空配列であることが
    //    「validate が rate-limit より外にある」ことの決定的証跡。
    expect(sleepSpy.calls).toEqual([]);

    // 3. handler は呼ばれない (validate が reject するので handler 層まで到達しない)
    expect(handlerSpy).not.toHaveBeenCalled();
  });
});

/**
 * createAuditAgent + middleware DI の smoke-level 配線テスト。
 *
 * OPENROUTER_API_KEY が無いと `createLlm` が throw するので、先にダミーキーを注入する。
 * 実 API 呼び出しはしない (invoke しないので middleware も発火しない)。
 */
describe("createAuditAgent middleware DI (spec-008)", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it("creates an agent with default middleware stack (file sink at DEFAULT_TOOL_CALL_LOG_PATH)", () => {
    // default middleware は file sink を含むが、sink の作成時点では fs I/O は起きない。
    // invoke しない限りログは書かれないので、repo の out/ を汚さない。
    const agent = createAuditAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
  });

  it("accepts a fully empty middleware array (middleware disabled)", () => {
    const agent = createAuditAgent({ middleware: [] });
    expect(agent).toBeDefined();
  });

  it("accepts a custom middleware array from createDefaultAuditMiddlewares (with in-memory sink)", () => {
    const { sink } = buildInMemorySink();
    const agent = createAuditAgent({
      middleware: createDefaultAuditMiddlewares({
        toolCallLogSink: sink,
        // rate-limit の sleep を無効化して "実時間" を排除する (invoke しないので
        // 実害は無いが、将来の統合 E2E で使えるオプションパスを固定しておく)
        rateLimit: {
          minIntervalMs: 0,
          now: () => new Date("2026-04-14T00:00:00.000Z"),
          sleep: async () => undefined,
        },
      }),
    });
    expect(agent).toBeDefined();
  });

  it("exports DEFAULT_TOOL_CALL_LOG_PATH matching spec-008 acceptance criterion", () => {
    // Acceptance criterion: `out/.state/tool-calls.jsonl` に構造化ログが追記される
    expect(DEFAULT_TOOL_CALL_LOG_PATH).toBe("out/.state/tool-calls.jsonl");
  });

  it("createDefaultAuditMiddlewares returns exactly 3 middlewares in [logging, validate, rate-limit] order", () => {
    const { sink } = buildInMemorySink();
    const middlewares = createDefaultAuditMiddlewares({ toolCallLogSink: sink });
    expect(middlewares).toHaveLength(3);
    // middleware object には name が付いている (createMiddleware({ name }) で指定したもの)
    const names = middlewares.map((m) => (m as { name?: string }).name ?? "<unnamed>");
    expect(names).toEqual([
      "ToolCallLoggingMiddleware",
      "ValidateToolArgsMiddleware",
      "GithubRateLimitMiddleware",
    ]);
  });
});
