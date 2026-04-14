import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ActionRequest, Decision } from "langchain";

import {
  DEFAULT_HITL_LOG_PATH,
  appendHitlEvents,
  createHitlLogEvent,
  formatHitlEventLine,
  readHitlEvents,
  type HitlLogEvent,
} from "../src/hitl-log";

/**
 * spec-006 HITL ログヘルパーのテスト。
 *
 * pure 関数部 (createHitlLogEvent / formatHitlEventLine) は決定論的にユニット
 * 検証。I/O 関数部 (appendHitlEvents / readHitlEvents) は tmpdir 上で round-trip
 * を回す (reporter の writeAuditReport テストと同じパターン)。
 */

describe("DEFAULT_HITL_LOG_PATH", () => {
  it("points to out/raw/hitl/log.jsonl so it is covered by .gitignore", () => {
    expect(DEFAULT_HITL_LOG_PATH).toBe("out/raw/hitl/log.jsonl");
  });
});

describe("createHitlLogEvent (pure)", () => {
  const fetchAction: ActionRequest = {
    name: "fetch_github",
    args: { owner: "mastra-ai", repo: "mastra" },
  };

  it("produces an approve event with the action name, args, and fixed timestamp", () => {
    const decision: Decision = { type: "approve" };
    const event = createHitlLogEvent(fetchAction, decision, {
      nowIso: "2026-04-14T00:00:00.000Z",
    });
    expect(event).toEqual({
      timestamp: "2026-04-14T00:00:00.000Z",
      toolName: "fetch_github",
      decision: "approve",
      args: { owner: "mastra-ai", repo: "mastra" },
    });
    expect(event).not.toHaveProperty("message");
  });

  it("propagates the reject message when the decision is reject", () => {
    const decision: Decision = {
      type: "reject",
      message: "ユーザーが CLI で却下",
    };
    const event = createHitlLogEvent(fetchAction, decision, {
      nowIso: "2026-04-14T00:00:00.000Z",
    });
    expect(event.decision).toBe("reject");
    expect(event.message).toBe("ユーザーが CLI で却下");
  });

  it("omits the message field when reject has no explanation", () => {
    const decision: Decision = { type: "reject" };
    const event = createHitlLogEvent(fetchAction, decision, {
      nowIso: "2026-04-14T00:00:00.000Z",
    });
    expect(event).not.toHaveProperty("message");
  });

  it("records edit decisions as 'edit' (actual arg rewriting is out of scope)", () => {
    const decision: Decision = {
      type: "edit",
      editedAction: { name: "fetch_github", args: { owner: "x", repo: "y" } },
    };
    const event = createHitlLogEvent(fetchAction, decision, {
      nowIso: "2026-04-14T00:00:00.000Z",
    });
    expect(event.decision).toBe("edit");
  });

  it("defaults the timestamp to the current ISO time when nowIso is omitted", () => {
    const before = Date.now();
    const event = createHitlLogEvent(fetchAction, { type: "approve" });
    const after = Date.now();
    const t = Date.parse(event.timestamp);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});

describe("formatHitlEventLine (pure)", () => {
  it("serializes one event to a single JSONL line ending with \\n", () => {
    const event: HitlLogEvent = {
      timestamp: "2026-04-14T00:00:00.000Z",
      toolName: "fetch_github",
      decision: "approve",
      args: { owner: "mastra-ai", repo: "mastra" },
    };
    const line = formatHitlEventLine(event);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.slice(0, -1));
    expect(parsed).toEqual(event);
  });

  it("falls back to an error line when the event contains a circular reference", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const event: HitlLogEvent = {
      timestamp: "2026-04-14T00:00:00.000Z",
      toolName: "fetch_github",
      decision: "approve",
      args: cyclic,
    };
    const line = formatHitlEventLine(event);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.slice(0, -1));
    expect(parsed.error).toMatch(/stringify/);
    expect(parsed.toolName).toBe("fetch_github");
    expect(parsed.decision).toBe("approve");
  });
});

describe("appendHitlEvents + readHitlEvents (I/O round-trip)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "hitl-log-test-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  function makeEvent(overrides: Partial<HitlLogEvent> = {}): HitlLogEvent {
    return {
      timestamp: "2026-04-14T00:00:00.000Z",
      toolName: "fetch_github",
      decision: "approve",
      args: { owner: "mastra-ai", repo: "mastra" },
      ...overrides,
    };
  }

  it("returns an empty array when the log file does not exist yet", async () => {
    const logPath = path.join(workdir, "missing.jsonl");
    const events = await readHitlEvents({ logPath });
    expect(events).toEqual([]);
  });

  it("round-trips a single event through append and read", async () => {
    const logPath = path.join(workdir, "one.jsonl");
    const event = makeEvent();
    await appendHitlEvents([event], { logPath });
    const read = await readHitlEvents({ logPath });
    expect(read).toEqual([event]);
  });

  it("creates intermediate directories automatically", async () => {
    const logPath = path.join(workdir, "deeply", "nested", "out", "log.jsonl");
    await appendHitlEvents([makeEvent()], { logPath });
    const info = await stat(logPath);
    expect(info.isFile()).toBe(true);
  });

  it("appends multiple events preserving order", async () => {
    const logPath = path.join(workdir, "multi.jsonl");
    const events: HitlLogEvent[] = [
      makeEvent({ toolName: "fetch_github", decision: "approve" }),
      makeEvent({
        toolName: "query_osv",
        decision: "reject",
        message: "CLI で却下",
      }),
      makeEvent({ toolName: "fetch_github", decision: "approve" }),
    ];
    await appendHitlEvents(events, { logPath });
    const read = await readHitlEvents({ logPath });
    expect(read).toHaveLength(3);
    expect(read[0]?.toolName).toBe("fetch_github");
    expect(read[1]?.toolName).toBe("query_osv");
    expect(read[1]?.decision).toBe("reject");
    expect(read[1]?.message).toBe("CLI で却下");
  });

  it("is append-only: a second call does not overwrite prior events", async () => {
    const logPath = path.join(workdir, "append.jsonl");
    await appendHitlEvents(
      [makeEvent({ toolName: "fetch_github" })],
      { logPath },
    );
    await appendHitlEvents(
      [makeEvent({ toolName: "query_osv" })],
      { logPath },
    );
    const read = await readHitlEvents({ logPath });
    expect(read.map((e) => e.toolName)).toEqual(["fetch_github", "query_osv"]);
  });

  it("is a no-op when given an empty events array", async () => {
    const logPath = path.join(workdir, "noop.jsonl");
    await appendHitlEvents([], { logPath });
    // File should not exist because no write happened.
    await expect(stat(logPath)).rejects.toThrow();
  });

  it("skips corrupted JSONL lines while keeping valid ones readable", async () => {
    const logPath = path.join(workdir, "mixed.jsonl");
    await appendHitlEvents([makeEvent({ toolName: "fetch_github" })], {
      logPath,
    });
    // Simulate a broken partial write by appending a non-JSON line directly.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(logPath, "this-is-not-json\n", "utf8");
    await appendHitlEvents([makeEvent({ toolName: "query_osv" })], {
      logPath,
    });

    const read = await readHitlEvents({ logPath });
    // The broken middle line is dropped, the two valid ones remain.
    expect(read).toHaveLength(2);
    expect(read[0]?.toolName).toBe("fetch_github");
    expect(read[1]?.toolName).toBe("query_osv");
  });

  it("persists the full JSONL content exactly as formatted", async () => {
    const logPath = path.join(workdir, "bytes.jsonl");
    const event = makeEvent({ decision: "reject", message: "だめ" });
    await appendHitlEvents([event], { logPath });
    const raw = await readFile(logPath, "utf8");
    expect(raw).toBe(formatHitlEventLine(event));
  });
});
