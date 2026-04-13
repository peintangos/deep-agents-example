import type { BaseStore } from "@langchain/langgraph-checkpoint";

import { memoryPath } from "../fs-layout";
import type { GenerateAuditReportInput } from "../reporter";
import { readMemoryJson, writeMemoryJson } from "./store-helpers";

/**
 * 過去の監査履歴の長期メモリ層。
 *
 * 同じ OSS を何度も再監査する際、前回の結果を参照することで「リリースが進んだ」
 * 「open issue 数が悪化した」のような差分を critic が捕捉できるようにする。
 * 月単位スナップショットで保存し、`/memories/history/<owner>-<repo>-<yyyy-mm>.json`
 * を 1 エントリ = 1 ファイルとする。
 *
 * 設計判断: **書き込みは agent ではなくオーケストレーション層 (CLI / reporter) の
 * 仕事**にする。LLM に構造化データを直接 `write_file` させると形式が崩れやすく、
 * かつ deepagents の `write_file` は既存ファイルを上書きできないため、
 * 「前回 (前月) のスナップショットがある状態で再実行」のフローでハマる。
 * ここで提供するのは
 *
 *   - パス生成 (`auditHistoryMemoryPath`)
 *   - 読み出し (`readAuditHistoryEntry`)
 *   - 書き込み (`writeAuditHistoryEntry`) ← orchestrator から呼ぶ
 *
 * の 3 つに留め、agent 側の system prompt には**読み出し方だけ**を指示する。
 *
 * 履歴エントリの形状は `GenerateAuditReportInput` をそのまま流用する (5 観点 raw
 * + critic findings + target + generatedAt)。reporter が組み立てるレポートと
 * 1:1 対応するため、CLI 側で `writeAuditReport(input)` のあとに
 * `writeAuditHistoryEntry(store, input)` を呼ぶだけで履歴化できる。
 */

/**
 * 履歴エントリの形状。`reporter.ts` の入力と同型なので、CLI からはレポート生成と
 * 履歴保存で同じ値を共有できる。
 */
export type AuditHistoryEntry = GenerateAuditReportInput;

/**
 * `{ owner, repo }` を `/memories/` のパス要素として安全な slug に変換する。
 *
 * GitHub のリポジトリ名に使える文字 (英数字 / ハイフン / アンダースコア / ドット)
 * を許容しつつ、それ以外は `-` に置換する。空文字や予期せぬ `/` の混入を弾く
 * ことで、誤って StoreBackend の namespace 検証 (`NAMESPACE_COMPONENT_RE`) の
 * 範囲外を踏まないようにする。
 */
export function slugifyAuditTarget(target: {
  readonly owner: string;
  readonly repo: string;
}): string {
  const sanitize = (s: string): string =>
    s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const owner = sanitize(target.owner);
  const repo = sanitize(target.repo);
  if (!owner || !repo) {
    throw new Error(
      `slugifyAuditTarget requires non-empty owner and repo, got: ${JSON.stringify(target)}`,
    );
  }
  return `${owner}-${repo}`;
}

/**
 * ISO 8601 タイムスタンプから `yyyy-mm` を抽出する。`Date` を経由せず文字列の
 * 先頭 7 文字を見るだけにすることで、タイムゾーンの曖昧さを完全に排除する
 * (履歴ファイル名がローカルタイムに依存するのは避けたい)。
 */
export function extractYearMonth(iso: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(iso);
  if (!match) {
    throw new Error(
      `extractYearMonth expects an ISO timestamp like "2026-04-14T...", got: ${iso}`,
    );
  }
  return `${match[1]}-${match[2]}`;
}

/**
 * 履歴エントリを保存するときの論理パス。
 *
 * 例: `auditHistoryMemoryPath({ owner: "mastra-ai", repo: "mastra" }, "2026-04")`
 *     → `"/memories/history/mastra-ai-mastra-2026-04.json"`
 */
export function auditHistoryMemoryPath(
  target: { readonly owner: string; readonly repo: string },
  yearMonth: string,
): string {
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new Error(
      `auditHistoryMemoryPath expects yearMonth in "yyyy-mm" form, got: ${yearMonth}`,
    );
  }
  const slug = slugifyAuditTarget(target);
  return memoryPath(`history/${slug}-${yearMonth}.json`);
}

/**
 * 既存の履歴エントリを読み出す。未保存または値が壊れている場合は `null`。
 */
export async function readAuditHistoryEntry(
  store: BaseStore,
  target: { readonly owner: string; readonly repo: string },
  yearMonth: string,
): Promise<AuditHistoryEntry | null> {
  return readMemoryJson<AuditHistoryEntry>(
    store,
    auditHistoryMemoryPath(target, yearMonth),
  );
}

/**
 * 履歴エントリを書き込む。`yearMonth` は `entry.generatedAt` から自動で導出する。
 *
 * 同月内に再実行した場合は同一パスに上書きされる (月単位のスナップショット
 * なので、月内の中間結果は最新で上書きするのが意図)。
 */
export async function writeAuditHistoryEntry(
  store: BaseStore,
  entry: AuditHistoryEntry,
  options: { readonly nowIso?: string } = {},
): Promise<void> {
  const yearMonth = extractYearMonth(entry.generatedAt);
  const path = auditHistoryMemoryPath(entry.target, yearMonth);
  await writeMemoryJson(store, path, entry, options);
}
