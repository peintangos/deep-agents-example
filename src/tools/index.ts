/**
 * サブエージェント共通で利用するツール群の barrel export。
 *
 * ツール設計の方針:
 *   - 外部 API を叩く `fetch_github` / `query_osv` は LangChain Tool として実装し、
 *     LLM から構造化引数で呼べるようにする。
 *   - 仮想 FS の読み書きは deepagents がデフォルトで提供する `read_file` /
 *     `write_file` / `edit_file` を使う。本プロジェクト固有の "raw/reports/memories"
 *     レイアウトは、サブエージェントの system_prompt で `rawPath()` 等から得た
 *     パス文字列を使うよう指示することで実現する。
 *
 *   → `read_raw` / `write_raw` を独自 Tool として定義しない設計判断の根拠:
 *     deepagents の仮想 FS 状態は filesystemMiddleware 経由で agent state に
 *     格納されており、独立した Tool から直接アクセスできないため。独自 Tool
 *     で包むと default tools と二重実装になり、整合性が壊れる。
 */

export { createFetchGithubTool } from "./fetch-github";
export { createQueryOsvTool } from "./query-osv";

// fs-layout のパスビルダーを再 export して、サブエージェント実装が
// 1 箇所からインポートできるようにする。
export {
  AUDIT_ASPECTS,
  FS_PREFIX,
  classifyPath,
  memoryPath,
  rawPath,
  reportPath,
  type AuditAspect,
  type FsScope,
} from "../fs-layout";
