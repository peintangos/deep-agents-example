import "dotenv/config";
import process, { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import type {
  ActionRequest,
  Decision,
  ReviewConfig,
} from "langchain";

import { runCli, type AgentInvoker } from "../src/cli";
import { createAuditAgent } from "../src/agent";
import {
  detectHitlInterrupt,
  formatActionForHuman,
  resolveHitlInterrupt,
  type HitlDecisionPolicy,
} from "../src/hitl";
import {
  appendHitlEvents,
  createHitlLogEvent,
  type HitlLogEvent,
} from "../src/hitl-log";

/**
 * HITL ループの安全装置。policy がバグって無限に interrupt を生み続けるケースを
 * 防ぐため、invoke → resume の往復回数をハード上限で切る。監査 1 回あたり 5〜10
 * 回の中断は想定内なので、20 あれば実用上十分で、かつ事故時に即座に検出できる
 * 境界値として選んだ。
 */
const MAX_HITL_ITERATIONS = 20;

/**
 * 対話型 HITL policy: 標準入出力で承認/却下をユーザーに尋ねる。副作用を伴うため
 * `src/hitl.ts` には置かず、この薄い entry 層にだけ存在する。
 *
 * 各 action ごとに readline インターフェースを開閉する実装は非効率に見えるが、
 * HITL の頻度 (監査 1 回で 5〜10 回程度) では問題にならない。ループをまたいで
 * rl を使い回すと stdin が閉じない / 再入時にハングするバグを踏みやすい。
 */
const consolePolicy: HitlDecisionPolicy = async (
  action: ActionRequest,
  review: ReviewConfig,
): Promise<Decision> => {
  process.stdout.write(`\n${formatActionForHuman(action, review)}\n`);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question("承認しますか? (y = approve / n = reject): "))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") {
      return { type: "approve" };
    }
    return {
      type: "reject",
      message: `ユーザーが CLI で ${action.name} を却下しました。`,
    };
  } finally {
    rl.close();
  }
};

/**
 * --invoke の実 invoker。createAuditAgent が HITL (interruptOn) を構成しているため、
 * 最初の `invoke` が interrupt で止まったら `consolePolicy` で承認を取って
 * `Command({ resume })` で再開する。この往復を interrupt が消えるまで繰り返す。
 *
 * thread_id は UUID で毎回新規に振る: MemorySaver は thread ごとに state を分離
 * するので、CLI の 1 呼び出しが別の過去実行と干渉しないようにするため。
 */
const realInvoker: AgentInvoker = async (prompt) => {
  const agent = createAuditAgent();
  const threadId = `audit-${randomUUID()}`;
  const config = { configurable: { thread_id: threadId } };

  let result: unknown = await agent.invoke(
    { messages: [{ role: "user", content: prompt }] },
    config,
  );

  for (let iteration = 0; iteration < MAX_HITL_ITERATIONS; iteration++) {
    const interrupt = detectHitlInterrupt(result);
    if (!interrupt) break;

    const response = await resolveHitlInterrupt(interrupt, consolePolicy);

    // 判断を監査履歴として `/raw/hitl/log.jsonl` に追記する。`resolveHitlInterrupt`
    // は `actionRequests` の順序を保ってそのまま `decisions` に詰めるため、
    // index ベースのペアリングで action[i] ↔ decisions[i] が正しく対応する。
    const actions = interrupt.value?.actionRequests ?? [];
    const events: HitlLogEvent[] = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const decision = response.decisions[i];
      if (!action || !decision) continue;
      events.push(createHitlLogEvent(action, decision));
    }
    await appendHitlEvents(events);

    result = await agent.invoke(new Command({ resume: response }), config);

    if (iteration === MAX_HITL_ITERATIONS - 1 && detectHitlInterrupt(result)) {
      throw new Error(
        `HITL loop exceeded ${MAX_HITL_ITERATIONS} iterations. ` +
          `Possible infinite interrupt — check the decision policy and interruptOn configuration.`,
      );
    }
  }

  // 最後のアシスタントメッセージの content を文字列として返す。
  const messages =
    (result as { messages?: Array<{ content?: unknown }> }).messages ?? [];
  const last = messages[messages.length - 1];
  const content = last?.content;

  if (typeof content === "string") return content;
  return JSON.stringify(content ?? result, null, 2);
};

const result = await runCli(process.argv, { invoker: realInvoker });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
