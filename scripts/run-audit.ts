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

import {
  runCli,
  buildAuditPrompt,
  type AgentInvoker,
  type AuditRunner,
} from "../src/cli";
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
import {
  extractAuditRawFromState,
  writeAuditReport,
  type CriticFindings,
} from "../src/reporter";

/**
 * HITL ループの安全装置。policy がバグって無限に interrupt を生み続けるケースを
 * 防ぐため、invoke → resume の往復回数をハード上限で切る。監査 1 回あたり 5〜10
 * 回の中断は想定内なので、20 あれば実用上十分で、かつ事故時に即座に検出できる
 * 境界値として選んだ。
 */
const MAX_HITL_ITERATIONS = 20;

/**
 * `--target` の出力先 (spec-009 acceptance criterion)。リポジトリ直下の
 * `out/mastra-audit-report.md` に固定する。ターゲットが mastra 以外でも
 * ファイル名は変えない方針 (本スクリプトは mastra を一次ターゲットとして設計
 * されており、他ターゲットで実行する場合も最新結果を同じパスに上書きする)。
 */
const DEFAULT_REPORT_PATH = "out/mastra-audit-report.md";

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
 * agent を invoke して、interrupt が出たら HITL policy で承認/却下を取りつつ
 * resume を繰り返し、最終 state を返す内部ヘルパ。
 *
 * `realInvoker` (`--invoke` 用) と `realAuditRunner` (`--target` 用) の両方が
 * この共通経路を使う。前者は最後のアシスタントメッセージだけ必要で、後者は
 * 仮想 FS に書き出された `/raw/<aspect>/result.json` が必要なので、
 * **最終 state をそのまま返す** のが最小公倍数。
 *
 * HITL 判断は `appendHitlEvents` で `/raw/hitl/log.jsonl` に追記される
 * (spec-006 の acceptance criterion)。
 */
async function invokeWithHitlLoop(
  prompt: string,
): Promise<{ agent: ReturnType<typeof createAuditAgent>; state: unknown }> {
  const agent = createAuditAgent();
  const threadId = `audit-${randomUUID()}`;
  const config = { configurable: { thread_id: threadId } };

  let state: unknown = await agent.invoke(
    { messages: [{ role: "user", content: prompt }] },
    config,
  );

  for (let iteration = 0; iteration < MAX_HITL_ITERATIONS; iteration++) {
    const interrupt = detectHitlInterrupt(state);
    if (!interrupt) break;

    const response = await resolveHitlInterrupt(interrupt, consolePolicy);

    const actions = interrupt.value?.actionRequests ?? [];
    const events: HitlLogEvent[] = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const decision = response.decisions[i];
      if (!action || !decision) continue;
      events.push(createHitlLogEvent(action, decision));
    }
    await appendHitlEvents(events);

    state = await agent.invoke(new Command({ resume: response }), config);

    if (iteration === MAX_HITL_ITERATIONS - 1 && detectHitlInterrupt(state)) {
      throw new Error(
        `HITL loop exceeded ${MAX_HITL_ITERATIONS} iterations. ` +
          `Possible infinite interrupt — check the decision policy and interruptOn configuration.`,
      );
    }
  }

  return { agent, state };
}

/**
 * --invoke の実 invoker。
 *
 * agent を invoke → HITL ループを回して → 最後のアシスタントメッセージの文字列を返す。
 * state 全体は破棄する (自由プロンプトなので raw 抽出は不要)。
 */
const realInvoker: AgentInvoker = async (prompt) => {
  const { state } = await invokeWithHitlLoop(prompt);

  const messages =
    (state as { messages?: Array<{ content?: unknown }> }).messages ?? [];
  const last = messages[messages.length - 1];
  const content = last?.content;

  if (typeof content === "string") return content;
  return JSON.stringify(content ?? state, null, 2);
};

/**
 * --target の実 auditRunner (spec-009)。
 *
 * 1. `buildAuditPrompt` で固定の監査プロンプトを組み立て
 * 2. `invokeWithHitlLoop` で agent を走らせて最終 state を取る
 * 3. `extractAuditRawFromState` で `/raw/<aspect>/result.json` と critic findings を JSON パース
 * 4. `writeAuditReport` で `out/mastra-audit-report.md` に Markdown を書き出す
 * 5. findings 数を入れた短い summary と report path を返す
 *
 * critic 未実行や一部 raw 欠落のケースでも失敗させず、reporter が "未取得"
 * プレースホルダで埋めたレポートを出力する (agent 側の不具合を人間が目視で
 * 検出しやすくするため)。
 */
const realAuditRunner: AuditRunner = async (target) => {
  const prompt = buildAuditPrompt(target.owner, target.repo);
  const { state } = await invokeWithHitlLoop(prompt);

  const extracted = extractAuditRawFromState(state);
  const generatedAt = new Date().toISOString();

  await writeAuditReport(
    {
      target,
      generatedAt,
      ...extracted,
    },
    DEFAULT_REPORT_PATH,
  );

  return {
    reportPath: DEFAULT_REPORT_PATH,
    summary: buildSummary(extracted.critic),
  };
};

function buildSummary(critic: CriticFindings | null): string {
  if (!critic) {
    return "監査完了 (critic 未実行 — raw データのみで中間レポートを生成)";
  }
  return `監査完了 (overall=${critic.overall_assessment}, findings=${critic.findings.length})`;
}

const result = await runCli(process.argv, {
  invoker: realInvoker,
  auditRunner: realAuditRunner,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
