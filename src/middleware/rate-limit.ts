/**
 * GitHub API レート制限対応 middleware (spec-008 Implementation Step 2)。
 *
 * **実装戦略**: response header (`X-RateLimit-Remaining`) を読む真の quota 追跡では
 * なく、**最小呼び出し間隔 (min-interval)** を強制する方式を採用する。GitHub の
 * authenticated limit は 5000/hour ≈ 1.4 req/sec なので、`minIntervalMs = 700`
 * (= ~1.43 req/sec 以下) を守れば実質的にレート上限に抵触しない。真の quota
 * 追跡は (1) tool の戻り値に headers を埋め込むか、(2) Github client 層に
 * observability を追加するかが必要で、spec-008 のスコープを超える。
 *
 * ## レイヤ分離
 *
 *   1. **Pure 層**: `computeSleepMs({ lastStartAt, now, minIntervalMs })` は副作用を
 *      持たない純粋関数。時計のスキューに対しても挙動を固定する (elapsed < 0 の
 *      ときは full interval を待つ)。
 *   2. **Middleware 層**: `createGithubRateLimitMiddleware(options)` が langchain の
 *      `createMiddleware({ wrapToolCall })` を返す。`now` と `sleep` を DI にして
 *      テストはゼロ実時間で決定論化できる。
 *
 * ## 既知の制約: 並列呼び出しに対する race
 *
 * langchain の `wrapToolCall` は通常 serial に呼ばれる (LLM が tool_calls 配列を
 * 返しても framework 側が 1 つずつ処理する) ので、`lastStartAt` の update は
 * サブ秒の race を起こさない。ただし、将来 parallel tool invocation が有効な
 * 構成 (async subagent 並列実行等) で同時に 2 つの `fetch_github` が来た場合、
 * 両方が同じ `lastStartAt` を読んで sleep=0 と判定し、rate limit に触れる
 * 可能性がある。その場合はまず native な langchain の parallelism 設定を
 * 見直すこと。この middleware で mutex を持つのは責務外 (現時点の spec-008
 * では spec-006 HITL と組み合わせて実質 serial に強制されている想定)。
 *
 * ## テスト戦略
 *
 * tests/middleware/rate-limit.test.ts で:
 *   - pure `computeSleepMs`: lastStartAt=null / elapsed≥interval / elapsed<interval /
 *     clock skew (elapsed<0) の 4 ケース
 *   - middleware: first call (sleep 0) / 2nd call within interval (sleep 差分) /
 *     2nd call after interval (sleep 0) / 非対象ツール (throughput-free)
 *   - sleep DI の呼び出し履歴を配列で記録して引数も検証
 */

import { createMiddleware } from "langchain";
import type { AgentMiddleware } from "langchain";

/**
 * GitHub authenticated API の 5000 req/hour = 1.388 req/sec から逆算した
 * 安全寄りのデフォルト最小間隔。100 ms のバッファを含めて 700 ms に設定 (実測
 * ~1.43 req/sec 以下なら rate limit に余裕がある)。
 *
 * 取り替えたい場合は `createGithubRateLimitMiddleware({ minIntervalMs: ... })`
 * で上書きできる。テストでは `1` ms のような極小値で high-throughput を模す。
 */
export const DEFAULT_GITHUB_MIN_INTERVAL_MS = 700;

/**
 * デフォルトでスロットル対象にするツール名。本プロジェクトでは GitHub API を
 * 叩くツールは `fetch_github` の 1 つだけなので single-element。GraphQL 版の
 * fetcher を追加した場合はこちらに入れる。
 */
export const DEFAULT_GITHUB_RATE_LIMIT_TOOL_NAMES: readonly string[] = [
  "fetch_github",
] as const;

export interface ComputeSleepMsInput {
  /** 前回のスロットル対象ツール呼び出し開始時刻。未呼び出しの場合は null */
  readonly lastStartAt: Date | null;
  /** 現在時刻 (now の呼び出し結果) */
  readonly now: Date;
  /** 最小呼び出し間隔 (ミリ秒) */
  readonly minIntervalMs: number;
}

/**
 * 次の呼び出しを何 ms 待たせるべきかを返す純粋関数。
 *
 * ロジック:
 *   - `lastStartAt === null` (初回呼び出し): 0 を返す
 *   - elapsed >= minIntervalMs: 0 を返す (十分な時間が経過済み)
 *   - elapsed < 0 (時計のスキュー): minIntervalMs を返す (full interval を待つ)
 *   - 0 <= elapsed < minIntervalMs: `minIntervalMs - elapsed` を返す
 *
 * **clock skew 対応**: 時計が逆戻りした場合に `minIntervalMs - elapsed` を
 * 素直に計算すると `minIntervalMs + |skew|` となり、skew が大きいと何時間も
 * 待つリスクがある。これを `minIntervalMs` にキャップすることで、最大でも
 * 1 interval 分しか待たないことを保証する。
 */
export function computeSleepMs(input: ComputeSleepMsInput): number {
  if (input.lastStartAt === null) return 0;
  const elapsed = input.now.getTime() - input.lastStartAt.getTime();
  if (elapsed >= input.minIntervalMs) return 0;
  if (elapsed < 0) return input.minIntervalMs;
  return input.minIntervalMs - elapsed;
}

export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface GithubRateLimitMiddlewareOptions {
  /**
   * 最小呼び出し間隔 (ミリ秒)。省略時は {@link DEFAULT_GITHUB_MIN_INTERVAL_MS}。
   */
  readonly minIntervalMs?: number;
  /**
   * スロットル対象のツール名リスト。省略時は {@link DEFAULT_GITHUB_RATE_LIMIT_TOOL_NAMES}
   * (fetch_github)。OSV / query_osv のような非 GitHub ツールは対象外。
   */
  readonly toolNames?: readonly string[];
  /**
   * 時刻プロバイダ。省略時は `() => new Date()`。テストから決定論的に
   * 差し替えるための DI。
   */
  readonly now?: () => Date;
  /**
   * Sleep 関数。省略時は `setTimeout` ベースの Promise。テストでは mock に
   * 差し替えて実時間をゼロにする。
   */
  readonly sleep?: SleepFn;
}

/**
 * GitHub API 系ツールに min-interval 方式のスロットルをかける middleware。
 *
 * **挙動**:
 *   - 対象外のツール (デフォルトでは `fetch_github` 以外) は完全に pass-through
 *   - 対象ツールの呼び出しが来ると `computeSleepMs` で必要な待ち時間を計算し、
 *     `sleep(ms)` で待機してから handler に委譲する
 *   - `lastStartAt` は "待ち終わって handler を呼び出す直前" の時刻に更新される。
 *     これにより連続した呼び出しが等間隔に並ぶ
 *   - handler が throw しても `lastStartAt` は update 済み (=次の call もスロットル
 *     対象になる)
 *
 * **pass-through の原則**: logging middleware と同様に、結果やエラーの変換は
 * 一切しない。スロットル以外の副作用 (state mutation / tool 結果変更 / systemPrompt
 * 書き換え等) は入れない。この薄さが後段タスクで validate middleware と組み合わせ
 * たときの wrap 順序可読性を守る。
 */
export function createGithubRateLimitMiddleware(
  options: GithubRateLimitMiddlewareOptions = {},
): AgentMiddleware {
  const minIntervalMs =
    options.minIntervalMs ?? DEFAULT_GITHUB_MIN_INTERVAL_MS;
  const toolNames = new Set(
    options.toolNames ?? DEFAULT_GITHUB_RATE_LIMIT_TOOL_NAMES,
  );
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;

  let lastStartAt: Date | null = null;

  return createMiddleware({
    name: "GithubRateLimitMiddleware",
    wrapToolCall: async (request, handler) => {
      if (!toolNames.has(request.toolCall.name)) {
        return handler(request);
      }
      const checkedAt = now();
      const sleepMs = computeSleepMs({
        lastStartAt,
        now: checkedAt,
        minIntervalMs,
      });
      if (sleepMs > 0) {
        await sleep(sleepMs);
      }
      // "待ち終わって handler を呼び出す直前" の時刻を計算。sleep した場合は
      // checkedAt + sleepMs、しなかった場合は checkedAt のまま。pure 計算で
      // 済ませると now() の呼び出し回数が 1/call に固定され、テストの now モックが
      // シンプルになる。
      lastStartAt = new Date(checkedAt.getTime() + sleepMs);
      return handler(request);
    },
  });
}
