import type { BaseStore } from "@langchain/langgraph-checkpoint";

import { memoryPath } from "../fs-layout";
import { readMemoryJson, writeMemoryJson } from "./store-helpers";

/**
 * 監査ポリシーの長期メモリ層。
 *
 * 監査ポリシーは「ユーザー / 組織が監査ごとに変えたい設定」を保持する場所で、
 * 観点ごとの重み付けや除外したいチェック項目、自由形式のメモを格納する。
 * セッションをまたいで `/memories/audit-policy.json` に永続化される想定で、
 * deepagents の長期メモリ配線 (`/memories/` → StoreBackend) に乗る。
 *
 * このモジュールは agent の外側 (CLI, テスト, セットアップスクリプト) から
 * ポリシーを読み書きするためのラッパーであり、内部的には
 * {@link readMemoryJson} / {@link writeMemoryJson} に委譲する。
 */

/**
 * 重み付けの対象となる監査観点。
 *
 * `fs-layout.ts` の `AuditAspect` には critic も含まれるが、critic は他の 5 観点を
 * 横断検証するメタステップであり、独立した重みを持たないので明示的に除外する。
 */
export type WeightableAuditAspect =
  | "license"
  | "security"
  | "maintenance"
  | "api-stability"
  | "community";

export const WEIGHTABLE_AUDIT_ASPECTS: readonly WeightableAuditAspect[] = [
  "license",
  "security",
  "maintenance",
  "api-stability",
  "community",
] as const;

/**
 * 監査ポリシーの形状。
 *
 * すべて optional とすることで「特定の観点だけ重みを上げたい」「除外項目だけ
 * 指定したい」といった部分的な利用を許容する。レポーター側が読むときは
 * 欠落しているフィールドにデフォルトを当てる責務を負う。
 */
export interface AuditPolicy {
  /**
   * 各観点の重み付け。値は相対値で、合計が 1.0 でなくても良い (reporter 側で
   * 必要に応じて正規化する)。critic は重みを持たないので含めない。
   */
  readonly weights?: Partial<Record<WeightableAuditAspect, number>>;

  /**
   * 除外したい個別チェック項目の識別子。観点とチェック名を `:` で区切る規約を
   * 推奨 (例: `"license:gpl-cross-check"`, `"security:dev-dep-cve"`)。
   */
  readonly excludedChecks?: readonly string[];

  /**
   * LLM や critic に伝えたい自由形式の補足メモ。組織固有の判断軸 (e.g. 「商用
   * SaaS 配布が前提」) を書いておくと critic の判定基準に流せる。
   */
  readonly notes?: string;
}

/**
 * `AuditPolicy` を `/memories/` 配下に保存するときの論理パス。
 * helper 側でプレフィックスストリッピングが行われるので、テストや agent 側の
 * `read_file` ツールから参照するときは**この値を使う**。
 */
export const AUDIT_POLICY_MEMORY_PATH = memoryPath("audit-policy.json");

/**
 * `AuditPolicy` の安全なデフォルト値。空オブジェクトと意味的に等価で、reporter
 * 側で「未設定状態」として扱える。
 */
export const DEFAULT_AUDIT_POLICY: AuditPolicy = Object.freeze({});

/**
 * `/memories/audit-policy.json` から監査ポリシーを読み出す。
 *
 * @returns 保存されたポリシー。未保存または値が壊れている場合は `null`
 */
export async function readAuditPolicy(
  store: BaseStore,
): Promise<AuditPolicy | null> {
  return readMemoryJson<AuditPolicy>(store, AUDIT_POLICY_MEMORY_PATH);
}

/**
 * `/memories/audit-policy.json` に監査ポリシーを保存する。既存値は上書きされ、
 * 内部の `created_at` は最初の書き込み時刻を維持しつつ `modified_at` のみ
 * 更新される。
 *
 * @param nowIso テスト時に時刻を固定したい場合のみ指定する
 */
export async function writeAuditPolicy(
  store: BaseStore,
  policy: AuditPolicy,
  options: { readonly nowIso?: string } = {},
): Promise<void> {
  await writeMemoryJson(store, AUDIT_POLICY_MEMORY_PATH, policy, options);
}
