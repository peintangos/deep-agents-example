/**
 * ツール呼び出しロギング middleware (spec-008 Implementation Step 1)。
 *
 * 横断的関心事としてのツール呼び出しログを langchain の `createMiddleware` 経由で
 * 差し込む。`wrapToolCall` フックで各ツール実行を try/catch + timer で囲み、
 * 成否 / 所要時間 / 引数 / 結果プレビューを **構造化 JSONL** として sink に渡す。
 *
 * ## レイヤ分離
 *
 * src/hitl-log.ts と同じ "pure core + I/O layer" の 2 段構成:
 *
 *   1. **Pure 層**: `buildToolCallLogEvent` と `formatToolCallEventLine` は副作用を
 *      持たない純粋関数。テスト側は入力に対する出力を直接 assert できる。
 *   2. **Sink 層**: `ToolCallLogSink` はイベントを受け取るただのコールバック。
 *      実装側が供給する (ファイル追記 / console / in-memory 配列など任意)。
 *   3. **I/O 層**: `createFileToolCallLogSink` + `appendToolCallEvents` はファイル
 *      システムを触る薄いラッパ。中継 JSONL (`out/.state/tool-calls.jsonl`) への追記を
 *      一箇所に集約する。
 *   4. **Middleware 層**: `createToolCallLoggingMiddleware(options)` が langchain の
 *      `createMiddleware({ wrapToolCall })` を返す。オプションは sink + `now` +
 *      result preview 長の 3 つだけ。agent 内部の state や tool 実体には一切
 *      依存しないので、langchain v1 以降の middleware インターフェース変更にも
 *      追従しやすい。
 *
 * ## テスト戦略
 *
 * tests/middleware/logging.test.ts で:
 *   - 成功ケース: in-memory sink + fakeModel + dummy tool で success event 形状を固定
 *   - 失敗ケース: tool が throw したとき status="error" で event を sinked + 例外は
 *     rethrow される (agent 側に成功を偽装しない)
 *   - 形式契約: `formatToolCallEventLine` が "1 line JSON + \n" を返す
 *   - File sink: tmpdir で mkdir -p + 追記が効く
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createMiddleware } from "langchain";
import type { AgentMiddleware } from "langchain";

/**
 * ツール呼び出しログの単一エントリ。
 *
 * 後から jq で grep できるように **フラットな構造化 JSON** にしておく。`args` と
 * `resultPreview` は長くなる可能性があるので最終層で trim する。
 */
export interface ToolCallLogEvent {
  /** ISO 8601 形式のイベント発生時刻 (ツール呼び出し完了時点) */
  readonly timestamp: string;
  /** 呼ばれたツール名 (例: `fetch_github`) */
  readonly toolName: string;
  /** tool_call.id (LangGraph が発行する UUID-ish) */
  readonly toolCallId: string;
  /** tool_call.args (LLM が決定した引数オブジェクト) */
  readonly args: Readonly<Record<string, unknown>>;
  /** 成功 / 失敗フラグ */
  readonly status: "success" | "error";
  /** ツール呼び出し開始から終了までの所要ミリ秒 (ceil) */
  readonly durationMs: number;
  /** 失敗時のエラーメッセージ (success 時は undefined) */
  readonly error?: string;
  /** 結果の先頭 N 文字プレビュー (デバッグ用、任意) */
  readonly resultPreview?: string;
}

/**
 * イベントを受け取る sink 関数。ファイル追記 / console / in-memory 配列など
 * 任意の実装を注入できる。非同期対応のため `Promise<void>` も許容する。
 */
export type ToolCallLogSink = (
  event: ToolCallLogEvent,
) => void | Promise<void>;

export interface BuildToolCallLogEventInput {
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
  };
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly outcome:
    | { readonly status: "success"; readonly resultPreview?: string }
    | { readonly status: "error"; readonly error: string };
}

/**
 * 入力から `ToolCallLogEvent` を組み立てる純粋関数。
 *
 * 副作用を持たないので、`now()` や `performance.now()` のような時刻依存の関数は
 * 呼び出し側で解決してから渡す (テストで `startedAt` / `completedAt` を固定値に
 * できる)。`durationMs` は `completedAt - startedAt` をミリ秒で計算し、負値は
 * 0 にクランプする (時計のずれに対する安全装置)。
 */
export function buildToolCallLogEvent(
  input: BuildToolCallLogEventInput,
): ToolCallLogEvent {
  const durationMs = Math.max(
    0,
    input.completedAt.getTime() - input.startedAt.getTime(),
  );
  const base = {
    timestamp: input.completedAt.toISOString(),
    toolName: input.toolCall.name,
    toolCallId: input.toolCall.id,
    args: input.toolCall.args,
    durationMs,
  };
  if (input.outcome.status === "success") {
    const event: ToolCallLogEvent = {
      ...base,
      status: "success",
    };
    if (input.outcome.resultPreview !== undefined) {
      return { ...event, resultPreview: input.outcome.resultPreview };
    }
    return event;
  }
  return {
    ...base,
    status: "error",
    error: input.outcome.error,
  };
}

/**
 * イベントを JSONL 1 行にシリアライズする。末尾に改行を含む。
 *
 * JSON.stringify は key の順序が実装依存なので、assert 側は個別フィールドを
 * parse して確認する想定。
 */
export function formatToolCallEventLine(event: ToolCallLogEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * ファイル追記型の sink を作るファクトリ。
 *
 * 初回呼び出し時に親ディレクトリが無ければ recursive に作成する。`out/.state/`
 * のような未作成パスをそのまま渡せる。ユーザーが別の sink (in-memory / console /
 * structured logger) を使いたい場合は `ToolCallLogSink` を直接渡せばよく、本関数は
 * 必須ではない。
 */
export function createFileToolCallLogSink(
  outputPath: string,
): ToolCallLogSink {
  return async (event) => {
    await mkdir(dirname(outputPath), { recursive: true });
    await appendFile(outputPath, formatToolCallEventLine(event), "utf8");
  };
}

/**
 * 複数イベントを一括でファイル追記するヘルパ (sink とは別ユースケース)。
 *
 * 監査完了後に pure 層の配列を一気に flush したいケースで使う。各行は
 * `formatToolCallEventLine` でシリアライズされる。
 */
export async function appendToolCallEvents(
  outputPath: string,
  events: readonly ToolCallLogEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await mkdir(dirname(outputPath), { recursive: true });
  const body = events.map(formatToolCallEventLine).join("");
  await appendFile(outputPath, body, "utf8");
}

export interface ToolCallLoggingMiddlewareOptions {
  /** 各イベントを受け取る sink 関数。必須 (デフォルトで副作用を入れないため)。 */
  readonly sink: ToolCallLogSink;
  /** テストから差し替え可能な時刻関数。デフォルトは `() => new Date()`。 */
  readonly now?: () => Date;
  /**
   * 成功時に残す result プレビューの最大文字数。デフォルト 200。
   * 結果文字列が長すぎるとログファイルが肥大化するので trim する。
   */
  readonly resultPreviewLimit?: number;
}

const DEFAULT_RESULT_PREVIEW_LIMIT = 200;

/**
 * ツール呼び出しを wrap して構造化ログを sink に渡す middleware を生成する。
 *
 * langchain の `createMiddleware({ wrapToolCall })` 経由で langchain v1 の
 * middleware パイプラインに差し込める。deepagents の `createDeepAgent()` も
 * この interface の middleware をそのまま受け付けるので、後段タスクで
 * `createAuditAgent` の `middleware` オプションに渡せば有効化できる。
 *
 * **副作用**:
 *   - sink への非同期 write が毎 tool 呼び出しで発生する (成功 / 失敗両方)
 *   - 失敗時は sink に書き込んだ後に **例外を rethrow** する。エージェント側に
 *     "成功したフリ" をさせず、LangGraph の通常エラー経路に戻す。
 *
 * **期待されない副作用**:
 *   - state の mutate (stateSchema 未指定)
 *   - ツール結果の変更 (handler の戻り値をそのまま返す)
 *   - agent の指示変更 (systemPrompt / tools / interruptOn いずれも触らない)
 *
 * この薄さを守ることで、spec-008 の他 2 つの middleware (rate-limit / validate)
 * と組み合わせたときに wrap 順序の影響を読みやすくする。
 */
export function createToolCallLoggingMiddleware(
  options: ToolCallLoggingMiddlewareOptions,
): AgentMiddleware {
  const { sink } = options;
  const now = options.now ?? (() => new Date());
  const previewLimit =
    options.resultPreviewLimit ?? DEFAULT_RESULT_PREVIEW_LIMIT;

  return createMiddleware({
    name: "ToolCallLoggingMiddleware",
    wrapToolCall: async (request, handler) => {
      const startedAt = now();
      // `request.toolCall.id` は `@langchain/core/messages` の ToolCall 由来で
      // `string | undefined`。ログは event 単位で追跡できる必要があるので、
      // undefined の場合は空文字にフォールバック (後続タスクで生成 UUID に
      // 差し替える余地を残す)。
      const toolCall = {
        id: request.toolCall.id ?? "",
        name: request.toolCall.name,
        args: request.toolCall.args ?? {},
      };
      try {
        const result = await handler(request);
        const completedAt = now();
        const resultPreview = extractResultPreview(result, previewLimit);
        const event = buildToolCallLogEvent({
          toolCall,
          startedAt,
          completedAt,
          outcome: { status: "success", resultPreview },
        });
        await sink(event);
        return result;
      } catch (error) {
        const completedAt = now();
        const event = buildToolCallLogEvent({
          toolCall,
          startedAt,
          completedAt,
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        });
        await sink(event);
        throw error;
      }
    },
  });
}

/**
 * ToolMessage / Command の戻り値から先頭 N 文字のプレビューを抽出する。
 *
 * `content` は string または MessageContentComplex[] のいずれか。複雑な content
 * は `JSON.stringify` して平文化したうえで slice する。Command のような
 * 戻り値はプレビュー対象外 (undefined を返す) にしてログを小さく保つ。
 */
function extractResultPreview(
  result: unknown,
  limit: number,
): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (content === undefined) return undefined;
  const text =
    typeof content === "string" ? content : JSON.stringify(content);
  if (text.length === 0) return undefined;
  return text.slice(0, limit);
}
