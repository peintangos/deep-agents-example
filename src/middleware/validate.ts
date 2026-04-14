/**
 * ツール引数バリデーション middleware (spec-008 Implementation Step 3)。
 *
 * 各ツールの zod schema は "空文字を弾く" 程度の入口チェックしか担保しないため、
 * GitHub API 系のように **正規表現レベルの厳密な命名規則** が必要なツールでは
 * middleware 層で 2 段目のバリデーションを重ねる。zod と重複する検査は避け、
 * zod が通してしまう "文法は string だが意味的に不正" なケース (例: owner に
 * スペース、repo に `../` を含む path traversal) だけを弾く。
 *
 * ## レイヤ分離
 *
 *   1. **Pure 層**: `validateGithubRepoArgs(args)` のような純粋関数。入力 (unknown)
 *      を narrow してから regex + 個別条件で `ValidationResult` を返す。
 *   2. **Registry 層**: `DEFAULT_TOOL_VALIDATORS` でツール名 → validator のマップを
 *      export する。既定では `fetch_github` だけ登録。呼び出し側は options で
 *      merge / override できる。
 *   3. **Middleware 層**: `createValidateToolArgsMiddleware(options)` が langchain の
 *      `createMiddleware({ wrapToolCall })` を返す。validation に失敗したら handler
 *      を呼ばずに `ToolMessage` を返して LLM に補正を促す (throw しない)。
 *
 * ## エラー返却の契約
 *
 * validation 失敗時は **`ToolMessage(content: "[validate] ... rejected: ...", tool_call_id)`**
 * を返す。これは langchain の "tool rejection" パターンで、LLM は次ターンで
 * ToolMessage の内容を読んで引数を修正 → 再試行できる。throw にしてしまうと
 * agent 全体が reject 経路に入って監査が止まるため、validation 用途には合わない。
 * 外部 API を叩く前に弾く点は `spec-006` の HITL interrupt と類似のねらいだが、
 * HITL は "人の承認" を挟むのに対して validate は "決定論的な入力チェック" に
 * 特化する。
 *
 * ## テスト戦略
 *
 * tests/middleware/validate.test.ts で:
 *   - pure validator: 合法 owner/repo / 空 / trailing-hyphen / invalid chars /
 *     repo path traversal / null / missing フィールド
 *   - middleware: 合法 → pass-through、不正 → ToolMessage(error) + handler 未呼び出し、
 *     非登録ツール → pass-through、custom validators override
 *   - exports: `DEFAULT_TOOL_VALIDATORS` の構成
 */

import { createMiddleware } from "langchain";
import type { AgentMiddleware } from "langchain";
import { ToolMessage } from "@langchain/core/messages";

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type ToolArgValidator = (args: unknown) => ValidationResult;

/**
 * GitHub username/org の受け入れ regex。
 *
 * 実際の GitHub ルール:
 *   - 1〜39 文字
 *   - 英数字とハイフン
 *   - 連続ハイフン禁止 / 先頭末尾ハイフン禁止
 *
 * regex だけだと **末尾ハイフン** を弾けない (character class に `-` を含むため)
 * ので、trailing hyphen は呼び出し側で別途チェックする。連続ハイフンは
 * "技術的には GitHub に存在しうる" ためここでは許容する (厳密すぎる regex が
 * 既存 repo を誤判定するリスクを避ける)。
 */
const GITHUB_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * GitHub repository name の受け入れ regex。
 *
 * 実際の GitHub ルール:
 *   - 1〜100 文字
 *   - 英数字 + `_`, `-`, `.`
 *   - 先頭が `.` は禁止 (regex の先頭 character class で `.` を除外している)
 *   - path traversal 防御として `/`, `\`, spaces 等を弾く
 */
const GITHUB_REPO_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;

/**
 * `fetch_github` の引数 (owner + repo) を検証する pure 関数。
 *
 * zod schema では空文字を弾くだけなので、ここでは GitHub の命名ルール相当の
 * regex と trailing-hyphen の個別チェックを重ねる。外部 API を叩く前に
 * 弾くことで、無駄な 404 / 400 を減らし rate limit 消費も抑える。
 */
export function validateGithubRepoArgs(args: unknown): ValidationResult {
  if (args === null || typeof args !== "object") {
    return { ok: false, error: "arguments must be a non-null object" };
  }
  const obj = args as Record<string, unknown>;
  const owner = obj.owner;
  const repo = obj.repo;

  if (typeof owner !== "string") {
    return {
      ok: false,
      error: `owner must be a string, received ${typeof owner}`,
    };
  }
  if (!GITHUB_OWNER_RE.test(owner)) {
    return {
      ok: false,
      error: `owner "${owner}" does not match GitHub username rules (alphanumeric + hyphen, 1-39 chars)`,
    };
  }
  if (owner.endsWith("-")) {
    // GITHUB_OWNER_RE が末尾ハイフンを弾けないための補助チェック。load-bearing。
    return {
      ok: false,
      error: `owner "${owner}" must not end with a hyphen`,
    };
  }

  if (typeof repo !== "string") {
    return {
      ok: false,
      error: `repo must be a string, received ${typeof repo}`,
    };
  }
  if (!GITHUB_REPO_RE.test(repo)) {
    return {
      ok: false,
      error: `repo "${repo}" does not match GitHub repository name rules (alphanumeric + "_-." , 1-100 chars, no leading dot)`,
    };
  }

  return { ok: true };
}

/**
 * ツール名 → validator の既定 registry。
 *
 * 既定では `fetch_github` のみ登録する。`query_osv` は zod schema の
 * `z.string().min(1)` で十分 (OSV 側は任意の string を受け付ける)。新しい
 * GitHub API 系ツールが増えたら呼び出し側で `validators` を merge する。
 */
export const DEFAULT_TOOL_VALIDATORS: Readonly<
  Record<string, ToolArgValidator>
> = {
  fetch_github: validateGithubRepoArgs,
};

export interface ValidateToolArgsMiddlewareOptions {
  /**
   * ツール名 → validator のマップ。省略時は {@link DEFAULT_TOOL_VALIDATORS}。
   * 呼び出し側で merge したい場合は `{...DEFAULT_TOOL_VALIDATORS, query_osv: ...}`
   * のように渡す。
   */
  readonly validators?: Readonly<Record<string, ToolArgValidator>>;
}

/**
 * 各ツール呼び出し前に引数を検証する middleware を生成する。
 *
 * **挙動**:
 *   - `validators` に登録されていないツール: pass-through (handler をそのまま呼ぶ)
 *   - 登録済みで検証成功: pass-through
 *   - 登録済みで検証失敗: `ToolMessage(content="[validate] ... rejected: ...",
 *     tool_call_id)` を返す。handler は **呼ばれない**。LLM は次ターンで ToolMessage
 *     の内容を見て引数を修正できる。
 *
 * **既定で含めない機能**:
 *   - validation エラーの sink / ログ記録: 必要なら logging middleware を
 *     validate middleware の内側に配置すれば logging が先に wrap するので記録される。
 *     順序は `createAuditAgent` の wiring タスクで決める。
 *   - retry: validation 失敗時に自動再試行はしない。LLM の判断に委ねる。
 */
export function createValidateToolArgsMiddleware(
  options: ValidateToolArgsMiddlewareOptions = {},
): AgentMiddleware {
  const validators = options.validators ?? DEFAULT_TOOL_VALIDATORS;

  return createMiddleware({
    name: "ValidateToolArgsMiddleware",
    wrapToolCall: async (request, handler) => {
      const validator = validators[request.toolCall.name];
      if (!validator) {
        return handler(request);
      }
      const result = validator(request.toolCall.args ?? {});
      if (result.ok) {
        return handler(request);
      }
      // rejection は ToolMessage として LLM に返す (throw しない)。
      // tool_call_id が undefined のときは空文字で埋めて型を満たす。
      return new ToolMessage({
        content: `[validate] tool "${request.toolCall.name}" rejected: ${result.error}`,
        tool_call_id: request.toolCall.id ?? "",
      });
    },
  });
}
