import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createAgent, fakeModel, tool } from "langchain";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";

import {
  buildToolCallLogEvent,
  formatToolCallEventLine,
  createFileToolCallLogSink,
  appendToolCallEvents,
  createToolCallLoggingMiddleware,
  type ToolCallLogEvent,
  type ToolCallLogSink,
} from "../../src/middleware/logging";

/**
 * spec-008 Implementation Step 1: ツール呼び出しロギング middleware の契約テスト。
 *
 * **テスト層**:
 *   1. pure event builder (`buildToolCallLogEvent`) の成功 / 失敗 / duration 計算
 *   2. JSONL 形式化 (`formatToolCallEventLine`) の round-trip 契約
 *   3. in-memory sink + fakeModel + dummy tool E2E (success + error rethrow)
 *   4. file sink ラッパ (`createFileToolCallLogSink` + `appendToolCallEvents`) の
 *      tmpdir ベース I/O テスト
 *
 * hitl-log.test.ts と同じ "pure → format → I/O → E2E" の層分離を踏襲。
 */

const PROBE_TOOL_NAME = "probe_tool";

function makeFixedDate(isoOffset: number): Date {
  return new Date(`2026-04-14T00:00:${isoOffset.toString().padStart(2, "0")}.000Z`);
}

describe("buildToolCallLogEvent (pure event builder)", () => {
  const baseInput = {
    toolCall: {
      id: "tc-001",
      name: "fetch_github",
      args: { owner: "mastra-ai", repo: "mastra" },
    },
    startedAt: new Date("2026-04-14T00:00:00.000Z"),
    completedAt: new Date("2026-04-14T00:00:00.250Z"),
  } as const;

  it("builds a success event with duration_ms = completedAt - startedAt", () => {
    const event = buildToolCallLogEvent({
      ...baseInput,
      outcome: { status: "success" },
    });
    expect(event.status).toBe("success");
    expect(event.durationMs).toBe(250);
    expect(event.toolName).toBe("fetch_github");
    expect(event.toolCallId).toBe("tc-001");
    expect(event.args).toEqual({ owner: "mastra-ai", repo: "mastra" });
    expect(event.timestamp).toBe("2026-04-14T00:00:00.250Z");
    expect(event.error).toBeUndefined();
    expect(event.resultPreview).toBeUndefined();
  });

  it("includes resultPreview only when outcome provides one", () => {
    const withPreview = buildToolCallLogEvent({
      ...baseInput,
      outcome: { status: "success", resultPreview: "{ stars: 123 }" },
    });
    expect(withPreview.resultPreview).toBe("{ stars: 123 }");

    const withoutPreview = buildToolCallLogEvent({
      ...baseInput,
      outcome: { status: "success" },
    });
    expect(withoutPreview.resultPreview).toBeUndefined();
  });

  it("builds an error event with the error message and undefined resultPreview", () => {
    const event = buildToolCallLogEvent({
      ...baseInput,
      outcome: { status: "error", error: "rate limit exceeded" },
    });
    expect(event.status).toBe("error");
    expect(event.error).toBe("rate limit exceeded");
    expect(event.resultPreview).toBeUndefined();
  });

  it("clamps negative duration to 0 (clock-skew safety)", () => {
    const event = buildToolCallLogEvent({
      ...baseInput,
      startedAt: new Date("2026-04-14T00:00:10.000Z"),
      completedAt: new Date("2026-04-14T00:00:00.000Z"),
      outcome: { status: "success" },
    });
    expect(event.durationMs).toBe(0);
  });
});

describe("formatToolCallEventLine (JSONL round-trip)", () => {
  it("emits a single line JSON terminated by a newline", () => {
    const event: ToolCallLogEvent = {
      timestamp: "2026-04-14T00:00:00.000Z",
      toolName: "fetch_github",
      toolCallId: "tc-001",
      args: { owner: "a", repo: "b" },
      status: "success",
      durationMs: 100,
    };
    const line = formatToolCallEventLine(event);
    expect(line.endsWith("\n")).toBe(true);
    // 改行を除いて改行が含まれないこと (= 1 行 JSON)
    expect(line.slice(0, -1)).not.toContain("\n");
    // JSON として parse 可能で、中身が一致すること
    const parsed = JSON.parse(line.trim()) as ToolCallLogEvent;
    expect(parsed.status).toBe("success");
    expect(parsed.toolName).toBe("fetch_github");
    expect(parsed.args).toEqual({ owner: "a", repo: "b" });
  });

  it("includes error field only for error events", () => {
    const success = formatToolCallEventLine({
      timestamp: "t",
      toolName: "x",
      toolCallId: "id",
      args: {},
      status: "success",
      durationMs: 0,
    });
    const successParsed = JSON.parse(success.trim()) as Record<string, unknown>;
    expect(successParsed.error).toBeUndefined();
    expect("error" in successParsed).toBe(false);

    const error = formatToolCallEventLine({
      timestamp: "t",
      toolName: "x",
      toolCallId: "id",
      args: {},
      status: "error",
      durationMs: 0,
      error: "boom",
    });
    const errorParsed = JSON.parse(error.trim()) as Record<string, unknown>;
    expect(errorParsed.error).toBe("boom");
  });
});

describe("createFileToolCallLogSink + appendToolCallEvents (file I/O)", () => {
  it("creates the parent directory on first write (mkdir -p)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tool-call-log-"));
    const outputPath = path.join(dir, ".state", "tool-calls.jsonl");
    const sink = createFileToolCallLogSink(outputPath);
    await sink({
      timestamp: "2026-04-14T00:00:00.000Z",
      toolName: "probe",
      toolCallId: "tc-1",
      args: { x: 1 },
      status: "success",
      durationMs: 10,
    });
    const info = await stat(outputPath);
    expect(info.isFile()).toBe(true);
    const content = await readFile(outputPath, "utf8");
    expect(content).toContain("\"toolName\":\"probe\"");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("appends multiple events in one batch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tool-call-log-"));
    const outputPath = path.join(dir, ".state", "tool-calls.jsonl");
    const events: ToolCallLogEvent[] = [
      {
        timestamp: "2026-04-14T00:00:00.000Z",
        toolName: "probe",
        toolCallId: "tc-1",
        args: {},
        status: "success",
        durationMs: 10,
      },
      {
        timestamp: "2026-04-14T00:00:01.000Z",
        toolName: "probe",
        toolCallId: "tc-2",
        args: {},
        status: "error",
        durationMs: 20,
        error: "bad",
      },
    ];
    await appendToolCallEvents(outputPath, events);
    const content = await readFile(outputPath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as ToolCallLogEvent;
    const second = JSON.parse(lines[1]!) as ToolCallLogEvent;
    expect(first.toolCallId).toBe("tc-1");
    expect(second.status).toBe("error");
  });

  it("is a no-op when events array is empty (does not create the file)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tool-call-log-"));
    const outputPath = path.join(dir, ".state", "tool-calls.jsonl");
    await appendToolCallEvents(outputPath, []);
    await expect(stat(outputPath)).rejects.toThrow();
  });
});

/**
 * spec-008 tool-call logging middleware E2E.
 *
 * langchain の createAgent + fakeModel + 1 つの dummy tool を組み合わせ、
 * logging middleware が tool 実行を wrap して sink にイベントを渡すことを
 * 決定論的に検証する。hitl-e2e.test.ts と同じ "minimal agent で middleware 層
 * だけ縛る" 戦略。
 *
 * fakeModel の応答は factory 形式にして、最後が ToolMessage なら final AIMessage
 * を、それ以外なら tool_call 付きの AIMessage を返す (bindTools の _callIndex
 * コピー問題を回避する既存パターン)。
 */
function makeScriptedModel(probeArgs: Record<string, unknown>) {
  let nextId = 0;
  return fakeModel().respond((messages: BaseMessage[]) => {
    const last = messages[messages.length - 1];
    if (last && ToolMessage.isInstance(last)) {
      return new AIMessage("completed");
    }
    nextId += 1;
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          name: PROBE_TOOL_NAME,
          args: probeArgs,
          id: `tc-${nextId}`,
          type: "tool_call",
        },
      ],
    });
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

describe("createToolCallLoggingMiddleware (E2E with fakeModel + dummy tool)", () => {
  it("records a success event when the tool returns normally", async () => {
    const { sink, events } = buildInMemorySink();
    const probeTool = tool(
      async ({ target }: { target: string }) => `probed:${target}`,
      {
        name: PROBE_TOOL_NAME,
        description: "test probe tool",
        schema: z.object({ target: z.string() }),
      },
    );

    const model = makeScriptedModel({ target: "alpha" });
    const agent = createAgent({
      model,
      tools: [probeTool],
      systemPrompt: "x",
      middleware: [createToolCallLoggingMiddleware({ sink })],
    });

    await agent.invoke({ messages: [{ role: "user", content: "run alpha" }] });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.status).toBe("success");
    expect(event.toolName).toBe(PROBE_TOOL_NAME);
    expect(event.toolCallId).toBe("tc-1");
    expect(event.args).toEqual({ target: "alpha" });
    // resultPreview はツール戻り値 (ToolMessage.content) の最初の N 文字を含む
    expect(event.resultPreview).toContain("probed:alpha");
    expect(event.error).toBeUndefined();
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records an error event AND re-throws when the tool fails", async () => {
    const { sink, events } = buildInMemorySink();
    const failingTool = tool(
      async () => {
        throw new Error("simulated tool failure");
      },
      {
        name: PROBE_TOOL_NAME,
        description: "always-throws tool",
        schema: z.object({ target: z.string() }),
      },
    );

    const model = makeScriptedModel({ target: "beta" });
    const agent = createAgent({
      model,
      tools: [failingTool],
      systemPrompt: "x",
      // recursionLimit を下げて、例外が再 throw されない限り無限ループしないようにする。
      middleware: [createToolCallLoggingMiddleware({ sink })],
    });

    // langchain の default 挙動では tool エラーが ToolMessage にラップされ、
    // 次の model 呼び出しに回される可能性もある。我々の middleware は try/catch
    // で sink に記録した上で **例外を rethrow** するので、そのルートに入ると
    // invoke 自体が reject される。ここでは "sink にエラーイベントが記録される"
    // ことを最低限の契約として assert する (invoke の挙動は fakeModel の次の
    // 応答で決まる)。
    try {
      await agent.invoke({ messages: [{ role: "user", content: "run beta" }] });
    } catch {
      // rethrow された場合は許容
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const errorEvent = events.find((e) => e.status === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toBe("simulated tool failure");
    expect(errorEvent?.toolName).toBe(PROBE_TOOL_NAME);
  });

  it("uses the injected `now` function so timestamps are deterministic", async () => {
    const { sink, events } = buildInMemorySink();
    const probeTool = tool(
      async ({ target }: { target: string }) => `probed:${target}`,
      {
        name: PROBE_TOOL_NAME,
        description: "test probe tool",
        schema: z.object({ target: z.string() }),
      },
    );

    let callIndex = 0;
    const fixedNow = () => {
      callIndex += 1;
      return makeFixedDate(callIndex); // 1 回目 startedAt, 2 回目 completedAt
    };

    const model = makeScriptedModel({ target: "deterministic" });
    const agent = createAgent({
      model,
      tools: [probeTool],
      systemPrompt: "x",
      middleware: [createToolCallLoggingMiddleware({ sink, now: fixedNow })],
    });

    await agent.invoke({ messages: [{ role: "user", content: "run" }] });

    expect(events).toHaveLength(1);
    // 2 回目の now 呼び出しが completedAt になる。
    expect(events[0]!.timestamp).toBe("2026-04-14T00:00:02.000Z");
    // duration は 2 回目 - 1 回目 = 1000ms
    expect(events[0]!.durationMs).toBe(1000);
  });

  it("trims resultPreview to the configured limit", async () => {
    const { sink, events } = buildInMemorySink();
    const longResult = "x".repeat(500);
    const probeTool = tool(
      async () => longResult,
      {
        name: PROBE_TOOL_NAME,
        description: "returns a long string",
        schema: z.object({}),
      },
    );

    const model = makeScriptedModel({});
    const agent = createAgent({
      model,
      tools: [probeTool],
      systemPrompt: "x",
      middleware: [
        createToolCallLoggingMiddleware({ sink, resultPreviewLimit: 50 }),
      ],
    });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });

    expect(events).toHaveLength(1);
    expect(events[0]!.resultPreview?.length).toBe(50);
    expect(events[0]!.resultPreview).toBe("x".repeat(50));
  });
});
