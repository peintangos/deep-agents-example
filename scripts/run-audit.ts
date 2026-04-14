import "dotenv/config";
import process, { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 * 直近ランで agent が書き出した `/raw/*` ファイルを保存するディレクトリ。
 *
 * spec-009 の初回ランで critic の JSON が 1 文字違いで壊れて全レポートが
 * 生成されないケースを踏んだので、**抽出の前に state.files の `/raw/*` を
 * そのまま disk にダンプする** 運用にした。次回ラン以降はここを覗けば
 * agent の生出力を目視デバッグできる。既存のダンプは毎ラン上書きされる
 * (履歴は git で取る)。
 */
const LAST_RUN_DUMP_DIR = "out/.state/last-run";

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
 * state.files の `/raw/*` プレフィックスのファイルをそのまま disk にダンプする。
 *
 * 目的は 2 つ:
 *   1. critic の JSON が 1 文字壊れているようなケースで agent の生出力を
 *      オフラインで検証できるようにする
 *   2. 次回ラン前にここを覗けば前回何が起きたか目視で診断できる
 *
 * `normalizeFileContent` を使いたいところだが reporter に private なので、
 * ここでは v1/v2/binary の 3 分岐を自前で処理する (薄いデバッグコードなので
 * ここに閉じた最小実装で良い)。parse せず生の string をそのまま保存する。
 */
async function dumpAuditRawFiles(
  state: unknown,
  outputDir: string,
): Promise<string[]> {
  if (state === null || typeof state !== "object") return [];
  const files = (state as { files?: unknown }).files;
  if (files === null || typeof files !== "object") return [];

  const filesRecord = files as Record<string, unknown>;
  const dumped: string[] = [];

  for (const [path, fileData] of Object.entries(filesRecord)) {
    if (!path.startsWith("/raw/")) continue;
    if (fileData === null || typeof fileData !== "object") continue;
    const content = (fileData as { content?: unknown }).content;

    let rawString: string;
    if (Array.isArray(content)) {
      rawString = content.join("\n");
    } else if (typeof content === "string") {
      rawString = content;
    } else if (content instanceof Uint8Array) {
      rawString = new TextDecoder("utf-8").decode(content);
    } else {
      // unknown shape — JSON.stringify としてダンプする (後で目視で原因追えるように)
      rawString = JSON.stringify(fileData, null, 2);
    }

    // `path` は `/raw/license/result.json` なので先頭 `/` を落として join
    const outPath = join(outputDir, path.replace(/^\//, ""));
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, rawString, "utf8");
    dumped.push(outPath);
  }

  return dumped;
}

/**
 * --target の実 auditRunner (spec-009)。
 *
 * 1. `buildAuditPrompt` で固定の監査プロンプトを組み立て
 * 2. `invokeWithHitlLoop` で agent を走らせて最終 state を取る
 * 3. **`dumpAuditRawFiles` で state の `/raw/*` を disk にそのまま保存**
 *    (抽出失敗時に agent の生出力を失わないための安全網)
 * 4. `extractAuditRawFromState` で 5 観点 + critic を JSON パース
 *    (per-field エラーは data.<field>=null にして errors[] に詰まる)
 * 5. errors があれば stderr に警告を出す (どの path がなぜ壊れたか + dump path)
 * 6. `writeAuditReport` でレポートを書き出す (壊れた raw は "未取得" プレースホルダに)
 * 7. summary を返す (成功数とエラー数を含める)
 *
 * critic 未実行や一部 raw の JSON 不正のケースでも **決して throw せず**、
 * 取れる範囲のレポートを生成する。これは spec-009 初回ランで critic の JSON が
 * 1 文字壊れただけで全レポートがゼロになる失敗モードへの対応。
 */
const realAuditRunner: AuditRunner = async (target) => {
  const prompt = buildAuditPrompt(target.owner, target.repo);
  const { state } = await invokeWithHitlLoop(prompt);

  const dumpedPaths = await dumpAuditRawFiles(state, LAST_RUN_DUMP_DIR);
  if (dumpedPaths.length > 0) {
    process.stderr.write(
      `\n[dump] agent が書き出した raw ファイル ${dumpedPaths.length} 件を ${LAST_RUN_DUMP_DIR}/ 配下に保存しました\n`,
    );
  } else {
    process.stderr.write(
      `\n[dump] state.files に /raw/ プレフィックスのファイルが見つかりませんでした (agent が raw を書き出していない可能性)\n`,
    );
  }

  const { data, errors } = extractAuditRawFromState(state);
  if (errors.length > 0) {
    process.stderr.write(
      `\n[warn] raw ファイルの抽出で ${errors.length} 件のエラーが発生しました (部分レポートを生成します)\n`,
    );
    for (const err of errors) {
      process.stderr.write(`  - ${err.path}: ${err.error}\n`);
    }
  }

  const generatedAt = new Date().toISOString();
  await writeAuditReport(
    {
      target,
      generatedAt,
      ...data,
    },
    DEFAULT_REPORT_PATH,
  );

  return {
    reportPath: DEFAULT_REPORT_PATH,
    summary: buildSummary(data.critic, errors.length),
  };
};

function buildSummary(
  critic: CriticFindings | null,
  extractionErrorCount: number,
): string {
  const errorNote =
    extractionErrorCount > 0
      ? ` [extraction errors: ${extractionErrorCount}, see ${LAST_RUN_DUMP_DIR}/]`
      : "";
  if (!critic) {
    return `監査完了 (critic 未取得 — 中間レポートを生成)${errorNote}`;
  }
  return `監査完了 (overall=${critic.overall_assessment}, findings=${critic.findings.length})${errorNote}`;
}

const result = await runCli(process.argv, {
  invoker: realInvoker,
  auditRunner: realAuditRunner,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
