import type { BaseStore } from "@langchain/langgraph-checkpoint";

import { FS_PREFIX } from "../fs-layout";

/**
 * `/memories/` 配下を BaseStore で直接読み書きするための低レベルヘルパー。
 *
 * deepagents の長期メモリ配線 (`CompositeBackend({ "/memories/": new StoreBackend() })`)
 * では、agent 側で `write_file("/memories/audit-policy.json", ...)` のように呼ぶと
 * CompositeBackend が `/memories/` プレフィックスを**剥がして** StoreBackend に渡し、
 * 結果として LangGraph store には以下の形で保存される。
 *
 *   namespace: ["filesystem"]
 *   key:       "/audit-policy.json"          // ← prefix なし, 先頭スラッシュ付き
 *   value:     { content, mimeType, created_at, modified_at }   // FileData v2
 *
 * このモジュールは CLI / テスト / セットアップスクリプトのような「agent の外」から
 * 同じデータを読み書きするための薄いラッパーで、StoreBackend 内部 API には依存せず
 * BaseStore を直接操作する。プレフィックスストリッピングと FileData v2 形状を
 * このモジュールに閉じ込めることで、policy / preferences / history の各ヘルパーが
 * 共通の規約を再実装せずに済む。
 *
 * agent との相互運用に関する注意:
 *   - helper 側は `store.put` を直接呼ぶためアップサートが成立する。一方
 *     deepagents の `write_file` ツールは StoreBackend.write 経由となり既存
 *     ファイルへの上書きをエラーで弾くため、helper で先に種付けしたキーに対して
 *     agent 側から書き込みたい場合は `edit_file` を使う必要がある。
 */

/**
 * StoreBackend がデフォルトで使う namespace。
 * deepagents v1.9 の `StoreBackend.getNamespace()` は zero-arg 構築時に
 * 固定値 `["filesystem"]` を返す。
 */
export const MEMORY_NAMESPACE = ["filesystem"] as const;

/**
 * `/memories/<rest>` 形式の論理パスを、StoreBackend が実際に store に書き込む
 * キー (`/<rest>`) に変換する。`CompositeBackend.getBackendAndKey` のロジックと
 * 完全に揃えてある。
 */
export function memoryStoreKey(memoryPath: string): string {
  const prefix = `${FS_PREFIX.MEMORIES}/`;
  if (!memoryPath.startsWith(prefix)) {
    throw new Error(
      `memoryStoreKey expects a path under ${prefix}, got: ${memoryPath}`,
    );
  }
  const suffix = memoryPath.substring(prefix.length);
  if (!suffix) {
    throw new Error(
      `memoryStoreKey expects a file path, not the bare ${prefix} root`,
    );
  }
  return `/${suffix}`;
}

/**
 * BaseStore に保存されている FileData v2 の最小形状。
 * StoreBackend.convertStoreItemToFileData が要求する必須フィールドのみ。
 */
interface MemoryFileValue {
  readonly content: string;
  readonly mimeType?: string;
  readonly created_at: string;
  readonly modified_at: string;
}

function isMemoryFileValue(value: unknown): value is MemoryFileValue {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.content === "string" &&
    typeof v.created_at === "string" &&
    typeof v.modified_at === "string"
  );
}

/**
 * `/memories/<path>` 配下から JSON 値を読み出す。存在しない / 形状が壊れている
 * 場合は `null` を返す (例外は投げない)。JSON パース失敗のみ例外を投げる。
 */
export async function readMemoryJson<T>(
  store: BaseStore,
  memoryPath: string,
): Promise<T | null> {
  const key = memoryStoreKey(memoryPath);
  const item = await store.get([...MEMORY_NAMESPACE], key);
  if (!item) return null;
  if (!isMemoryFileValue(item.value)) return null;
  return JSON.parse(item.value.content) as T;
}

/**
 * `/memories/<path>` 配下に JSON 値を書き込む。既存キーは上書きされ、その際
 * `created_at` は最初の書き込み時刻を維持し `modified_at` のみ更新される。
 *
 * `nowIso` を注入できるようにしているのはテストで時刻を固定するため。
 */
export async function writeMemoryJson(
  store: BaseStore,
  memoryPath: string,
  data: unknown,
  options: { readonly nowIso?: string } = {},
): Promise<void> {
  const key = memoryStoreKey(memoryPath);
  const now = options.nowIso ?? new Date().toISOString();
  const existing = await store.get([...MEMORY_NAMESPACE], key);
  const createdAt =
    existing && isMemoryFileValue(existing.value)
      ? existing.value.created_at
      : now;
  const value: MemoryFileValue = {
    content: JSON.stringify(data, null, 2),
    mimeType: "application/json",
    created_at: createdAt,
    modified_at: now,
  };
  await store.put([...MEMORY_NAMESPACE], key, value);
}
