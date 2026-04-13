import type { BaseStore } from "@langchain/langgraph-checkpoint";

import { memoryPath } from "../fs-layout";
import {
  WEIGHTABLE_AUDIT_ASPECTS,
  type WeightableAuditAspect,
} from "./policy";
import { readMemoryJson, writeMemoryJson } from "./store-helpers";

/**
 * ユーザー好み (レポート文体 / 優先観点) の長期メモリ層。
 *
 * `AuditPolicy` が「監査の判断軸 (重み / 除外項目)」を扱うのに対し、こちらは
 * 「最終レポートの見せ方 / 関心の強い観点」を扱う。両者を分けているのは:
 *
 *   - policy はチームや組織の判断ポリシー (誰が読んでも同じ)
 *   - preferences は個々のユーザーの好み (レポートを誰向けに書くかで変わる)
 *
 * という意味的な層が違うため。内部実装はどちらも `/memories/` 配下の JSON で、
 * 共通の {@link readMemoryJson} / {@link writeMemoryJson} に委譲する。
 *
 * 初回利用フロー (spec 参照):
 *   1. 最初の監査実行で対話的にユーザーへ確認 (CLI / HITL レイヤの責務)
 *   2. 次回以降は `readUserPreferences` で自動復元してプロンプトに流す
 *
 * このモジュールは 1 と 2 の両方から使われる前提で設計してある。
 */

/**
 * レポートの文体。`formal` は「だ/である」調、`polite` は「ですます」調。
 * reporter 側はこの値を見て見出しや文末を切り替える想定 (spec-005 の文脈では
 * メモリへの round-trip だけを担保し、reporter 側の対応は後続 spec)。
 */
export type ReportTone = "formal" | "polite";

export const REPORT_TONES: readonly ReportTone[] = ["formal", "polite"] as const;

/**
 * ユーザー好みの形状。
 *
 * - `tone`: レポート文体
 * - `priorityAspects`: 「特に詳しく見たい」観点。重み付けではなく**順序付きの
 *   関心リスト**として扱う (critic は除外。理由は `policy.ts` の
 *   `WeightableAuditAspect` と同じ)。重複は排除する想定で、helper 側で正規化
 *   する
 * - `notes`: 自由記述。後の spec で reporter / critic に流す
 */
export interface UserPreferences {
  readonly tone?: ReportTone;
  readonly priorityAspects?: readonly WeightableAuditAspect[];
  readonly notes?: string;
}

export const USER_PREFERENCES_MEMORY_PATH = memoryPath("user-preferences.json");

export const DEFAULT_USER_PREFERENCES: UserPreferences = Object.freeze({});

/**
 * `priorityAspects` を正規化する。
 *
 * - 重複を削除 (順序は最初の出現を維持)
 * - `WEIGHTABLE_AUDIT_ASPECTS` に含まれない値は捨てる (型レベルでは弾けないが、
 *   JSON から復元したときに不正値が入る可能性があるので runtime でも防御する)
 *
 * 入力が `undefined` ならそのまま `undefined` を返す (空配列との区別を保つ)。
 */
export function normalizePriorityAspects(
  aspects: readonly WeightableAuditAspect[] | undefined,
): readonly WeightableAuditAspect[] | undefined {
  if (aspects === undefined) return undefined;
  const allowed = new Set<string>(WEIGHTABLE_AUDIT_ASPECTS);
  const seen = new Set<WeightableAuditAspect>();
  const result: WeightableAuditAspect[] = [];
  for (const aspect of aspects) {
    if (!allowed.has(aspect)) continue;
    if (seen.has(aspect)) continue;
    seen.add(aspect);
    result.push(aspect);
  }
  return result;
}

/**
 * `/memories/user-preferences.json` から読み出す。未保存または値が壊れている
 * 場合は `null`。
 */
export async function readUserPreferences(
  store: BaseStore,
): Promise<UserPreferences | null> {
  const raw = await readMemoryJson<UserPreferences>(
    store,
    USER_PREFERENCES_MEMORY_PATH,
  );
  if (raw === null) return null;
  // priorityAspects は JSON 経由で不正値が混入し得るので必ず正規化する。
  if (raw.priorityAspects !== undefined) {
    return {
      ...raw,
      priorityAspects: normalizePriorityAspects(raw.priorityAspects),
    };
  }
  return raw;
}

/**
 * `/memories/user-preferences.json` に書き込む。`priorityAspects` は書き込み前に
 * 正規化されるため、呼び出し側は重複排除を気にしなくて良い。
 *
 * `nowIso` はテスト時に時刻を固定するためのフック。
 */
export async function writeUserPreferences(
  store: BaseStore,
  preferences: UserPreferences,
  options: { readonly nowIso?: string } = {},
): Promise<void> {
  const normalized: UserPreferences =
    preferences.priorityAspects !== undefined
      ? {
          ...preferences,
          priorityAspects: normalizePriorityAspects(preferences.priorityAspects),
        }
      : preferences;
  await writeMemoryJson(
    store,
    USER_PREFERENCES_MEMORY_PATH,
    normalized,
    options,
  );
}
