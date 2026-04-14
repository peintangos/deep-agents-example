import { describe, it, expect, vi } from "vitest";
import type {
  ActionRequest,
  Decision,
  HITLRequest,
  ReviewConfig,
} from "langchain";
import type { Interrupt } from "@langchain/langgraph";

import {
  APPROVE_ALL_POLICY,
  REJECT_ALL_POLICY,
  detectHitlInterrupt,
  formatActionForHuman,
  resolveHitlInterrupt,
  type HitlDecisionPolicy,
} from "../src/hitl";

/**
 * spec-006 HITL pure core のユニットテスト。
 *
 * detect / resolve / format / presets の 4 ピースはすべて副作用無しで書かれて
 * いるので、LangGraph runtime や readline を一切立ち上げずに検証できる。
 * テスト方針は `tests/reporter.test.ts` と同じで、**偽の入力を組み立てて
 * pure 関数に流し、返り値の構造をアサートする** スタイル。
 */

function makeRequest(overrides: Partial<HITLRequest> = {}): HITLRequest {
  return {
    actionRequests: [],
    reviewConfigs: [],
    ...overrides,
  };
}

function makeInterrupt(
  request: HITLRequest,
  id = "interrupt-1",
): Interrupt<HITLRequest> {
  return { id, value: request };
}

describe("detectHitlInterrupt", () => {
  it("returns null for null / undefined state", () => {
    expect(detectHitlInterrupt(null)).toBeNull();
    expect(detectHitlInterrupt(undefined)).toBeNull();
  });

  it("returns null for non-object state", () => {
    expect(detectHitlInterrupt("not an object")).toBeNull();
    expect(detectHitlInterrupt(42)).toBeNull();
    expect(detectHitlInterrupt(true)).toBeNull();
  });

  it("returns null when __interrupt__ is missing", () => {
    expect(detectHitlInterrupt({})).toBeNull();
    expect(detectHitlInterrupt({ messages: [] })).toBeNull();
  });

  it("returns null when __interrupt__ is an empty array", () => {
    expect(detectHitlInterrupt({ __interrupt__: [] })).toBeNull();
  });

  it("returns null when __interrupt__ is not an array", () => {
    expect(detectHitlInterrupt({ __interrupt__: "not-an-array" })).toBeNull();
    expect(detectHitlInterrupt({ __interrupt__: {} })).toBeNull();
  });

  it("returns the first interrupt from a non-empty batch", () => {
    const first = makeInterrupt(makeRequest(), "i-1");
    const second = makeInterrupt(makeRequest(), "i-2");
    const state = { __interrupt__: [first, second] };
    expect(detectHitlInterrupt(state)).toBe(first);
  });

  it("returns null when the first entry is not an object", () => {
    const state = { __interrupt__: ["primitive"] };
    expect(detectHitlInterrupt(state)).toBeNull();
  });
});

describe("resolveHitlInterrupt", () => {
  it("throws when interrupt.value is missing", async () => {
    const interrupt: Interrupt<HITLRequest> = { id: "x" };
    await expect(
      resolveHitlInterrupt(interrupt, APPROVE_ALL_POLICY),
    ).rejects.toThrowError(/HITLRequest/);
  });

  it("produces one decision per actionRequest (preserving order)", async () => {
    const request = makeRequest({
      actionRequests: [
        { name: "fetch_github", args: { owner: "mastra-ai", repo: "mastra" } },
        { name: "query_osv", args: { package: "mastra" } },
      ],
      reviewConfigs: [
        { actionName: "fetch_github", allowedDecisions: ["approve", "reject"] },
        { actionName: "query_osv", allowedDecisions: ["approve", "reject"] },
      ],
    });
    const response = await resolveHitlInterrupt(
      makeInterrupt(request),
      APPROVE_ALL_POLICY,
    );
    expect(response.decisions).toEqual([{ type: "approve" }, { type: "approve" }]);
  });

  it("matches reviewConfig to action by actionName", async () => {
    const request = makeRequest({
      actionRequests: [{ name: "query_osv", args: { pkg: "lodash" } }],
      reviewConfigs: [
        { actionName: "fetch_github", allowedDecisions: ["approve"] },
        { actionName: "query_osv", allowedDecisions: ["approve", "reject"] },
      ],
    });
    const seen: ReviewConfig[] = [];
    const policy: HitlDecisionPolicy = (_action, review) => {
      seen.push(review);
      return { type: "approve" };
    };
    await resolveHitlInterrupt(makeInterrupt(request), policy);
    expect(seen).toHaveLength(1);
    const first = seen[0];
    expect(first?.actionName).toBe("query_osv");
    expect(first?.allowedDecisions).toEqual(["approve", "reject"]);
  });

  it("falls back to an empty-allowedDecisions review when no config matches", async () => {
    const request = makeRequest({
      actionRequests: [{ name: "mystery_tool", args: {} }],
      reviewConfigs: [],
    });
    const seen: ReviewConfig[] = [];
    const policy: HitlDecisionPolicy = (_action, review) => {
      seen.push(review);
      return { type: "approve" };
    };
    await resolveHitlInterrupt(makeInterrupt(request), policy);
    expect(seen[0]).toEqual({
      actionName: "mystery_tool",
      allowedDecisions: [],
    });
  });

  it("awaits async policies", async () => {
    const request = makeRequest({
      actionRequests: [{ name: "fetch_github", args: {} }],
      reviewConfigs: [
        { actionName: "fetch_github", allowedDecisions: ["approve", "reject"] },
      ],
    });
    const policy: HitlDecisionPolicy = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { type: "reject", message: "async reject" };
    };
    const response = await resolveHitlInterrupt(makeInterrupt(request), policy);
    expect(response.decisions[0]).toEqual({
      type: "reject",
      message: "async reject",
    });
  });

  it("returns an empty decisions array when there are no action requests", async () => {
    const request = makeRequest({ actionRequests: [] });
    const response = await resolveHitlInterrupt(
      makeInterrupt(request),
      APPROVE_ALL_POLICY,
    );
    expect(response).toEqual({ decisions: [] });
  });

  it("calls the policy with the actual ActionRequest object (args inspection)", async () => {
    const action: ActionRequest = {
      name: "fetch_github",
      args: { owner: "mastra-ai", repo: "mastra" },
    };
    const request = makeRequest({
      actionRequests: [action],
      reviewConfigs: [
        { actionName: "fetch_github", allowedDecisions: ["approve", "reject"] },
      ],
    });
    const policy = vi.fn<HitlDecisionPolicy>(() => ({ type: "approve" }));
    await resolveHitlInterrupt(makeInterrupt(request), policy);
    expect(policy).toHaveBeenCalledTimes(1);
    const [receivedAction] = policy.mock.calls[0] ?? [];
    expect(receivedAction).toEqual(action);
  });
});

describe("formatActionForHuman", () => {
  const baseReview: ReviewConfig = {
    actionName: "fetch_github",
    allowedDecisions: ["approve", "reject"],
  };

  it("includes the tool name in the first line", () => {
    const text = formatActionForHuman(
      { name: "fetch_github", args: {} },
      baseReview,
    );
    expect(text.split("\n")[0]).toContain("fetch_github");
    expect(text).toContain("承認が必要");
  });

  it("lists the allowed decisions", () => {
    const text = formatActionForHuman(
      { name: "fetch_github", args: {} },
      baseReview,
    );
    expect(text).toContain("approve, reject");
  });

  it("pretty-prints the action args as JSON", () => {
    const text = formatActionForHuman(
      {
        name: "fetch_github",
        args: { owner: "mastra-ai", repo: "mastra" },
      },
      baseReview,
    );
    expect(text).toContain('"owner": "mastra-ai"');
    expect(text).toContain('"repo": "mastra"');
  });

  it("falls back gracefully when args contain a circular reference", () => {
    const args: Record<string, unknown> = {};
    args.self = args;
    const text = formatActionForHuman(
      { name: "fetch_github", args },
      baseReview,
    );
    expect(text).toContain("unable to stringify");
  });

  it("omits the allowedDecisions line when the review has none", () => {
    const text = formatActionForHuman(
      { name: "mystery", args: {} },
      { actionName: "mystery", allowedDecisions: [] },
    );
    expect(text).not.toContain("許可されている判断");
  });
});

describe("preset policies", () => {
  const dummyAction: ActionRequest = { name: "fetch_github", args: {} };
  const dummyReview: ReviewConfig = {
    actionName: "fetch_github",
    allowedDecisions: ["approve", "reject"],
  };

  it("APPROVE_ALL_POLICY always returns approve", async () => {
    const decision: Decision = await APPROVE_ALL_POLICY(dummyAction, dummyReview);
    expect(decision).toEqual({ type: "approve" });
  });

  it("REJECT_ALL_POLICY always returns reject with a Japanese explanation", async () => {
    const decision: Decision = await REJECT_ALL_POLICY(dummyAction, dummyReview);
    expect(decision.type).toBe("reject");
    if (decision.type === "reject") {
      // 日本語 (CJK) を含むことを確認。英語だけだと LLM に伝えるメッセージとして弱い。
      expect(decision.message).toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
    }
  });

  it("APPROVE_ALL_POLICY can be composed with resolveHitlInterrupt for a full-approve flow", async () => {
    const request = makeRequest({
      actionRequests: [
        { name: "fetch_github", args: {} },
        { name: "query_osv", args: {} },
      ],
      reviewConfigs: [
        { actionName: "fetch_github", allowedDecisions: ["approve", "reject"] },
        { actionName: "query_osv", allowedDecisions: ["approve", "reject"] },
      ],
    });
    const response = await resolveHitlInterrupt(
      makeInterrupt(request),
      APPROVE_ALL_POLICY,
    );
    expect(response.decisions.every((d) => d.type === "approve")).toBe(true);
  });

  it("REJECT_ALL_POLICY can be composed with resolveHitlInterrupt to block external calls", async () => {
    const request = makeRequest({
      actionRequests: [{ name: "fetch_github", args: {} }],
      reviewConfigs: [
        { actionName: "fetch_github", allowedDecisions: ["approve", "reject"] },
      ],
    });
    const response = await resolveHitlInterrupt(
      makeInterrupt(request),
      REJECT_ALL_POLICY,
    );
    expect(response.decisions).toHaveLength(1);
    expect(response.decisions[0]?.type).toBe("reject");
  });
});
