import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActionRequest, Decision } from "langchain";

/**
 * HITL 承認/却下イベントのログヘルパー。
 *
 * agent の HITL 中断 (fetch_github / query_osv 等) に対してユーザーが下した
 * 判断を JSONL (1 行 1 JSON) で追記する。監査の後で「どのツール呼び出しが承認
 * され、どれが却下されたか」を再構成できるようにするのが目的で、Zenn 記事の
 * 題材や監査レポートのメタデータとしても使う。
 *
 * 設計判断:
 *   - **物理ファイル** (`out/raw/hitl/log.jsonl`) に書く。spec の "`/raw/hitl/log.jsonl`"
 *     という表記は論理パスで、HITL は CLI 層 (`scripts/run-audit.ts`) が emit する
 *     イベントのため、agent の仮想 FS 上には流さない。`out/` は既に `.gitignore` 済み
 *     なので追加設定不要 (spec-004 の `.gitignore` 確認済み)
 *   - **JSONL フォーマット**: 1 行 1 イベントの append-only 形式。再起動やクラッシュで
 *     中途半端な書き込みが残っても、後続行で復帰できる。`JSON.stringify(event) + "\n"`
 *     のシンプルな serializer で十分
 *   - **pure 関数 + I/O ラッパ** の分離: `formatHitlEventLine` と
 *     `createHitlLogEvent` は pure で、`appendHitlEvents` / `readHitlEvents` が
 *     I/O を担当。tests/hitl-log.test.ts で pure 部分は決定論的に検証、I/O 部分は
 *     tmpdir で検証する (spec-004 の reporter.ts / writeAuditReport と同じパターン)
 */

/**
 * 1 つの HITL 判断を表すログイベント。JSONL の各行がこの形にシリアライズされる。
 */
export interface HitlLogEvent {
  /** ISO 8601 タイムスタンプ (イベント発火時刻) */
  readonly timestamp: string;
  /** 承認対象のツール名 (例: `fetch_github`) */
  readonly toolName: string;
  /** ユーザーの判断 */
  readonly decision: "approve" | "reject" | "edit";
  /** reject 時の理由 (`RejectDecision.message` をそのまま) */
  readonly message?: string;
  /** ツール呼び出しの引数 (再現性のため。巨大なら省略可) */
  readonly args?: unknown;
}

/**
 * デフォルトのログ出力先。`out/` 配下に置くことで `.gitignore` 済みとなり、
 * 誤ってリポジトリに混入しない。
 */
export const DEFAULT_HITL_LOG_PATH = "out/raw/hitl/log.jsonl" as const;

/**
 * `ActionRequest` + `Decision` のペアからログイベントを組み立てる pure 関数。
 *
 * `nowIso` はテスト時に時刻を固定するためのフック。省略時は呼び出し時点の
 * `new Date().toISOString()` を使う。
 */
export function createHitlLogEvent(
  action: ActionRequest,
  decision: Decision,
  options: { readonly nowIso?: string } = {},
): HitlLogEvent {
  const timestamp = options.nowIso ?? new Date().toISOString();
  const base = {
    timestamp,
    toolName: action.name,
    decision: decision.type,
    args: action.args,
  } as const;
  if (decision.type === "reject" && decision.message) {
    return { ...base, message: decision.message };
  }
  return base;
}

/**
 * 1 イベントを JSONL の 1 行に serialize する。**末尾改行込み** で返す。
 * `JSON.stringify` が throw するようなケース (循環参照) は呼び出し側で
 * 起きないはずだが、万一のために catch してエラー行を書き出す。
 */
export function formatHitlEventLine(event: HitlLogEvent): string {
  try {
    return `${JSON.stringify(event)}\n`;
  } catch {
    const fallback = {
      timestamp: event.timestamp,
      toolName: event.toolName,
      decision: event.decision,
      error: "unable to stringify original event (circular reference?)",
    };
    return `${JSON.stringify(fallback)}\n`;
  }
}

/**
 * 複数イベントを 1 回の append で物理ファイルに追記する。
 *
 * 親ディレクトリが存在しない場合は `{ recursive: true }` で自動作成する。
 * append-only なので既存行は一切触らず、再実行で past log と混ざらない。
 */
export async function appendHitlEvents(
  events: readonly HitlLogEvent[],
  options: { readonly logPath?: string } = {},
): Promise<void> {
  if (events.length === 0) return;
  const logPath = options.logPath ?? DEFAULT_HITL_LOG_PATH;
  await mkdir(dirname(logPath), { recursive: true });
  const payload = events.map(formatHitlEventLine).join("");
  await appendFile(logPath, payload, "utf8");
}

/**
 * ログファイル全体を読み出して行ごとにパースする。ファイルが存在しない場合は
 * 空配列を返す (まだ 1 回も HITL が発火していない状態と区別しない)。
 *
 * JSONL のうち JSON として壊れている行があった場合は、**その行だけをスキップ**
 * して他の行を返す。壊れた行で全体を落とすと、過去の有効な判断履歴がすべて
 * 失われてしまうため。
 */
export async function readHitlEvents(
  options: { readonly logPath?: string } = {},
): Promise<HitlLogEvent[]> {
  const logPath = options.logPath ?? DEFAULT_HITL_LOG_PATH;
  let content: string;
  try {
    content = await readFile(logPath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  const events: HitlLogEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as HitlLogEvent);
    } catch {
      // skip broken line; see fn doc
      continue;
    }
  }
  return events;
}
