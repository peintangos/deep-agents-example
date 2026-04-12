/**
 * 仮想ファイルシステムのレイアウト定義。
 *
 * deepagents の backend は path-keyed なファイルストアを提供する。
 * このモジュールは各サブエージェントと最終レポート生成が読み書きする
 * 論理的な "ディレクトリ" を型安全に組み立てるためのヘルパーを集約する。
 *
 * プレフィックス契約:
 *   - `/raw/<aspect>/` : 各監査観点のサブエージェントが raw データを書き出す場所
 *   - `/reports/`     : 最終レポート (および再利用可能な中間レポート) の置き場
 *   - `/memories/`    : deepagents の長期メモリ領域 (セッションをまたいで永続化)
 *   - それ以外        : セッション内の一時データ (transient)
 */

export const FS_PREFIX = {
  RAW: "/raw",
  REPORTS: "/reports",
  MEMORIES: "/memories",
} as const;

export const AUDIT_ASPECTS = [
  "license",
  "security",
  "maintenance",
  "api-stability",
  "community",
  "critic",
] as const;

export type AuditAspect = (typeof AUDIT_ASPECTS)[number];

export type FsScope = "raw" | "report" | "memory" | "transient";

export function rawPath(aspect: AuditAspect, filename: string): string {
  return `${FS_PREFIX.RAW}/${aspect}/${filename}`;
}

export function reportPath(filename: string): string {
  return `${FS_PREFIX.REPORTS}/${filename}`;
}

export function memoryPath(filename: string): string {
  return `${FS_PREFIX.MEMORIES}/${filename}`;
}

export function classifyPath(path: string): FsScope {
  if (path.startsWith(`${FS_PREFIX.RAW}/`)) return "raw";
  if (path.startsWith(`${FS_PREFIX.REPORTS}/`)) return "report";
  if (path.startsWith(`${FS_PREFIX.MEMORIES}/`)) return "memory";
  return "transient";
}
