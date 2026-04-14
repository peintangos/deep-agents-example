import type {
  ActionRequest,
  Decision,
  HITLRequest,
  HITLResponse,
  ReviewConfig,
} from "langchain";
import type { Interrupt } from "@langchain/langgraph";

/**
 * HITL (Human-in-the-Loop) の承認フローを **副作用無しで** 組み立てるための pure core。
 *
 * このモジュールが提供するのは以下の 4 ピース:
 *
 *   1. {@link detectHitlInterrupt} — agent.invoke の結果から interrupt を抽出
 *   2. {@link HitlDecisionPolicy} / {@link resolveHitlInterrupt} — interrupt を
 *      1 つの `HITLResponse` に畳み込む (per-action policy を適用)
 *   3. {@link formatActionForHuman} — 承認対象を人間向けの文字列に整形
 *   4. {@link APPROVE_ALL_POLICY} / {@link REJECT_ALL_POLICY} — プリセット policy
 *
 * 対話 I/O (readline / console.log) や LangGraph の `Command({ resume })` 構築は
 * このモジュールの責務ではない。`scripts/run-audit.ts` が上記を組み合わせて
 * ループを回し、ユーザーに質問してから resume する薄いラッパを担う。
 *
 * この "pure core + thin I/O entry" 分離は spec-001 の `runCli` と同じ戦略で、
 * すべての判定ロジックをユニットテストで決定論的に覆えるようにすることが目的。
 */

/**
 * 承認対象ごとに {@link Decision} を返す関数。
 *
 * 引数として渡される `review` には `allowedDecisions` (どの判断が許されるか) と
 * `argsSchema` (edit で引数を差し替えるときの schema) が入っている。policy 実装は
 * `allowedDecisions` に含まれない決定を返してはいけない — 返してしまった場合
 * langchain 側の HITL middleware が実行時に弾く。`src/agent.ts` の
 * `DEFAULT_INTERRUPT_ON` では approve / reject しか許していないため、edit を
 * 使う policy を書くときはまず `interruptOn` の設定を見直すこと。
 */
export type HitlDecisionPolicy = (
  action: ActionRequest,
  review: ReviewConfig,
) => Promise<Decision> | Decision;

/**
 * deepagents の `agent.invoke` 戻り値は `__interrupt__?: Interrupt<HITLRequest>[]`
 * を持ち得る。このフィールドは **配列** で、複数ツールが同時に承認要求されると
 * 単一 interrupt の中に複数 {@link ActionRequest} が詰め込まれる (langchain の
 * HITL middleware ドキュメント参照)。
 *
 * ここでは **先頭の 1 つ** を取り出す。langchain の現行実装では同時に複数の
 * interrupt batch が積まれるのは稀で、中断 → resume → 次の interrupt batch という
 * ループ構造で処理されるため、呼び出し側 (実行ループ) は先頭だけを繰り返し
 * 取り出せば十分。
 */
export function detectHitlInterrupt(
  state: unknown,
): Interrupt<HITLRequest> | null {
  if (state === null || typeof state !== "object") return null;
  const record = state as { __interrupt__?: unknown };
  const batch = record.__interrupt__;
  if (!Array.isArray(batch) || batch.length === 0) return null;
  const first = batch[0];
  if (first === null || typeof first !== "object") return null;
  return first as Interrupt<HITLRequest>;
}

/**
 * `actionRequests` と `reviewConfigs` を対応付けて、1 つずつ {@link HitlDecisionPolicy}
 * に通して {@link HITLResponse} を組み立てる。
 *
 * 対応付けは `reviewConfigs[i].actionName` が `actionRequests[j].name` と一致する
 * 最初のエントリを使う。マッチしない action は policy に **`allowedDecisions` 空、
 * `actionName` は action.name** のフォールバック review を渡す。これは langchain
 * 側の middleware が実行時に "review 未定義 = 対象外" として自動承認する挙動に
 * 合わせた寛容なデフォルト (policy 側は空配列を見て approve を選ぶ想定)。
 */
export async function resolveHitlInterrupt(
  interrupt: Interrupt<HITLRequest>,
  policy: HitlDecisionPolicy,
): Promise<HITLResponse> {
  const request = interrupt.value;
  if (!request) {
    throw new Error(
      "resolveHitlInterrupt: interrupt.value (HITLRequest) is missing",
    );
  }

  const reviewByName = new Map<string, ReviewConfig>();
  for (const review of request.reviewConfigs ?? []) {
    if (!reviewByName.has(review.actionName)) {
      reviewByName.set(review.actionName, review);
    }
  }

  const decisions: Decision[] = [];
  for (const action of request.actionRequests ?? []) {
    const review: ReviewConfig = reviewByName.get(action.name) ?? {
      actionName: action.name,
      allowedDecisions: [],
    };
    const decision = await policy(action, review);
    decisions.push(decision);
  }

  return { decisions };
}

/**
 * 1 つの承認対象を人間向けの多行文字列に整形する。console 表示や readline の
 * 前置き文として使う想定。引数の JSON.stringify は壊れたデータ (循環参照) が
 * 混入した場合でも例外を上げないように try/catch する。
 */
export function formatActionForHuman(
  action: ActionRequest,
  review: ReviewConfig,
): string {
  let argsText: string;
  try {
    argsText = JSON.stringify(action.args, null, 2);
  } catch {
    argsText = "<unable to stringify args>";
  }

  const lines: string[] = [];
  lines.push(`[HITL] ツール実行の承認が必要です: ${action.name}`);
  if (review.allowedDecisions.length > 0) {
    lines.push(`  許可されている判断: ${review.allowedDecisions.join(", ")}`);
  }
  lines.push(`  引数:`);
  for (const line of argsText.split("\n")) {
    lines.push(`    ${line}`);
  }
  return lines.join("\n");
}

/**
 * テストと CI 用プリセット: すべての承認要求を **approve** で返す。
 */
export const APPROVE_ALL_POLICY: HitlDecisionPolicy = () => ({
  type: "approve",
});

/**
 * 「外部 API は一切叩かない」モードで使うプリセット: すべての承認要求を
 * `reject` で返す。reject 時の説明文は langchain が LLM に戻すため、reject の
 * 理由を LLM が理解できる日本語で書いておく。
 */
export const REJECT_ALL_POLICY: HitlDecisionPolicy = () => ({
  type: "reject",
  message:
    "ユーザーがこのツール呼び出しを却下しました。代替経路 (キャッシュ / 手動入力) を検討してください。",
});
