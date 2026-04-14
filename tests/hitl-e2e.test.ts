import { describe, it, expect } from "vitest";
import {
  createAgent,
  fakeModel,
  humanInTheLoopMiddleware,
  tool,
} from "langchain";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Command } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  APPROVE_ALL_POLICY,
  REJECT_ALL_POLICY,
  detectHitlInterrupt,
  resolveHitlInterrupt,
} from "../src/hitl";

/**
 * spec-006 最終タスク: interrupt → resume → 完了 の 1 サイクルを E2E で縛る。
 *
 * **差し替え戦略**: 実 LLM は呼ばず `fakeModel()` を使う。agent も重量級の
 * `createDeepAgent` ではなく **langchain の `createAgent` + `humanInTheLoopMiddleware`**
 * を直接叩いた最小構成にする。deepagents のデフォルト middleware (summarization /
 * todoList / filesystem 等) は HITL ロジックとは独立で、むしろ callCount を
 * 膨らませて失敗時の切り分けを難しくする。本テストで検証したいのは `src/hitl.ts`
 * の pure core (detect / resolve) が **LangGraph の interrupt() と正しく往復する**
 * ことなので、agent を最小にしたほうが論点が明確になる。
 *
 * `createAuditAgent` 側の HITL 配線は `tests/smoke.test.ts` の 6 ケースで既に
 * 覆われており、本 E2E はそのロジック部分の動作証跡を追加する位置づけ。
 *
 * **検証するもの**:
 *
 *   1. 初回 invoke で fakeModel が tool_call を出し、HITL middleware が
 *      interrupt で止める
 *   2. `detectHitlInterrupt` が state から interrupt を抽出できる
 *   3. `resolveHitlInterrupt` が approve / reject を HITLResponse に畳み込める
 *   4. `new Command({ resume })` で agent を再開すると最終 AIMessage が返る
 *   5. 同じ `thread_id` を使った連続 invoke が MemorySaver 経由で state を
 *      引き継ぐ (別スレッドだと resume が効かない)
 */

const EXTERNAL_PROBE_TOOL_NAME = "external_probe";

/**
 * fakeModel の `_callIndex` が bindTools のたびに値コピーされる制約
 * (node_modules/@langchain/core/dist/testing/fake_model_builder.js:126) を回避する
 * ため、queue にはただ 1 つの **factory** を入れておき、その factory が **messages を
 * 見てその場で返すべき応答を決める** 形にする。これで agent が invoke ごとに
 * bindTools を作り直しても挙動が決定論的になる。
 *
 * ルール:
 *   - 最後のメッセージが ToolMessage なら「既に tool が実行済み」と解釈し、
 *     tool_calls を持たない最終 AIMessage ("{completionMarker}") を返して終了する
 *   - それ以外 (初回呼び出し + tool message なし) なら external_probe への
 *     tool_call を載せた AIMessage を返し、HITL 中断を誘発する
 */
function makeScriptedModel(params: {
  readonly probeArgs: Record<string, unknown>;
  readonly completionMarker: string;
}) {
  let nextToolCallId = 0;
  return fakeModel().respond((messages: BaseMessage[]) => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && ToolMessage.isInstance(lastMessage)) {
      return new AIMessage(params.completionMarker);
    }
    nextToolCallId += 1;
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          name: EXTERNAL_PROBE_TOOL_NAME,
          args: params.probeArgs,
          id: `tc-${nextToolCallId}`,
          type: "tool_call",
        },
      ],
    });
  });
}

function createAgentForTest(model: ReturnType<typeof fakeModel>) {
  const probeTool = tool(
    async ({ target }: { target: string }) => `probed:${target}`,
    {
      name: EXTERNAL_PROBE_TOOL_NAME,
      description:
        "テスト用の外部副作用ツール。HITL の承認対象として使う (実際には文字列を返すだけ)。",
      schema: z.object({
        target: z.string().describe("プローブ対象"),
      }),
    },
  );

  return createAgent({
    model,
    tools: [probeTool],
    systemPrompt:
      "テスト用エージェント。external_probe を呼んで結果を報告してください。",
    checkpointer: new MemorySaver(),
    middleware: [
      humanInTheLoopMiddleware({
        interruptOn: {
          [EXTERNAL_PROBE_TOOL_NAME]: {
            allowedDecisions: ["approve", "reject"],
            description: "external_probe の実行前承認",
          },
        },
      }),
    ],
  });
}

function freshThreadConfig() {
  return { configurable: { thread_id: `hitl-e2e-${randomUUID()}` } };
}

function lastMessageContent(state: unknown): string {
  const messages = (state as { messages?: BaseMessage[] }).messages ?? [];
  const last = messages[messages.length - 1];
  const content = last?.content;
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

describe("spec-006 HITL interrupt → resume → complete E2E (fakeModel)", () => {
  it("stops at an interrupt on the first invoke when the model issues a tool_call", async () => {
    const model = makeScriptedModel({
      probeArgs: { target: "alpha" },
      completionMarker: "完了",
    });
    const agent = createAgentForTest(model);
    const config = freshThreadConfig();

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "alpha を調べて" }] },
      config,
    );

    const interrupt = detectHitlInterrupt(result);
    expect(interrupt).not.toBeNull();

    const request = interrupt?.value;
    expect(request?.actionRequests).toHaveLength(1);
    const action = request?.actionRequests[0];
    expect(action?.name).toBe(EXTERNAL_PROBE_TOOL_NAME);
    expect(action?.args).toEqual({ target: "alpha" });
  });

  it("completes the run when the human approves (tool executes, model returns final message)", async () => {
    const model = makeScriptedModel({
      probeArgs: { target: "beta" },
      completionMarker: "監査完了: probed:beta を受領",
    });
    const agent = createAgentForTest(model);
    const config = freshThreadConfig();

    // Phase 1: initial invoke → interrupted
    const first = await agent.invoke(
      { messages: [{ role: "user", content: "beta を調べて" }] },
      config,
    );
    const interrupt = detectHitlInterrupt(first);
    expect(interrupt).not.toBeNull();

    // Phase 2: resolve with APPROVE_ALL_POLICY → Command({resume})
    const response = await resolveHitlInterrupt(interrupt!, APPROVE_ALL_POLICY);
    expect(response.decisions).toEqual([{ type: "approve" }]);

    // Phase 3: resume with the SAME thread_id (critical for MemorySaver lookup)
    const second = await agent.invoke(new Command({ resume: response }), config);

    // After resume the interrupt should be gone and the model should have
    // returned its final AIMessage.
    expect(detectHitlInterrupt(second)).toBeNull();
    expect(lastMessageContent(second)).toContain("監査完了");
  });

  it("completes with a reject decision without executing the tool", async () => {
    const model = makeScriptedModel({
      probeArgs: { target: "gamma" },
      completionMarker: "却下を受けて代替経路を取りました",
    });
    const agent = createAgentForTest(model);
    const config = freshThreadConfig();

    const first = await agent.invoke(
      { messages: [{ role: "user", content: "gamma を調べて" }] },
      config,
    );
    const interrupt = detectHitlInterrupt(first);
    expect(interrupt).not.toBeNull();

    const response = await resolveHitlInterrupt(interrupt!, REJECT_ALL_POLICY);
    expect(response.decisions[0]?.type).toBe("reject");

    const second = await agent.invoke(new Command({ resume: response }), config);

    expect(detectHitlInterrupt(second)).toBeNull();
    // 最終 AIMessage の content はテスト側で固定したもの。reject 時は middleware が
    // 合成 ToolMessage を messages に注入し、その後 model が再度呼ばれるので、
    // fakeModel の 2 つ目のレスポンス (AIMessage) が最終状態に残る。
    expect(lastMessageContent(second)).toContain("却下");
    expect(model.callCount).toBe(2);
  });

  it("isolates state by thread_id: two independent runs do not interfere", async () => {
    // 並行実行シナリオ: 2 つの独立した thread を 1 つの checkpointer 上で回しても
    // state が混ざらないことを確認する。MemorySaver は thread_id ごとに state を
    // 分離するため、同じ agent インスタンスで問題なく両方を個別に resume できる。
    //
    // Model は **人間メッセージから target を抽出するディスパッチ factory** にして
    // おき、queue 位置に依存しない形で thread ごとに別レスポンスを返せるようにする。
    const model = fakeModel().respond((messages: BaseMessage[]) => {
      const humanText = messages
        .filter((m) => m._getType() === "human")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("");
      const target = humanText.includes("A")
        ? "run-A"
        : humanText.includes("B")
          ? "run-B"
          : "unknown";
      const last = messages[messages.length - 1];
      if (last && ToolMessage.isInstance(last)) {
        return new AIMessage(`${target} 完了`);
      }
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            name: EXTERNAL_PROBE_TOOL_NAME,
            args: { target },
            id: `tc-${target}`,
            type: "tool_call",
          },
        ],
      });
    });
    const agent = createAgentForTest(model);
    const configA = freshThreadConfig();
    const configB = freshThreadConfig();

    const firstA = await agent.invoke(
      { messages: [{ role: "user", content: "A を調べて" }] },
      configA,
    );
    const firstB = await agent.invoke(
      { messages: [{ role: "user", content: "B を調べて" }] },
      configB,
    );

    const intA = detectHitlInterrupt(firstA);
    const intB = detectHitlInterrupt(firstB);
    expect(intA).not.toBeNull();
    expect(intB).not.toBeNull();
    expect(intA?.value?.actionRequests[0]?.args).toEqual({ target: "run-A" });
    expect(intB?.value?.actionRequests[0]?.args).toEqual({ target: "run-B" });

    const resA = await resolveHitlInterrupt(intA!, APPROVE_ALL_POLICY);
    const resB = await resolveHitlInterrupt(intB!, APPROVE_ALL_POLICY);

    const secondA = await agent.invoke(new Command({ resume: resA }), configA);
    const secondB = await agent.invoke(new Command({ resume: resB }), configB);

    expect(lastMessageContent(secondA)).toContain("A 完了");
    expect(lastMessageContent(secondB)).toContain("B 完了");
  });
});
