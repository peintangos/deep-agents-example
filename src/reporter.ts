/**
 * 監査レポート生成モジュール。
 *
 * 5 観点のサブエージェントが書き出した raw データと critic の整合性検証結果を
 * 受け取り、Markdown 文字列を組み立てる純粋関数を提供する。
 *
 * 設計方針:
 *   - I/O を持たない pure function (`generateAuditReport`) を中核に置くことで、
 *     deepagents の仮想 FS 上のデータでも、ユニットテストのモック JSON でも、
 *     同じ関数でレポートを組み立てられる。
 *   - 副作用を伴う薄いラッパ (`writeAuditReport`) を別途 export し、実ファイル
 *     (`out/*.md`) への書き出しと intermediate directory の作成を一箇所に集約する。
 *     オーケストレーション層 (CLI / agent.ts) はこのラッパを呼ぶだけでよい。
 *   - サブエージェントの raw データは `Record<string, unknown>` として受け取り、
 *     未知のフィールドも失わずに JSON ブロックで埋め込む。個別フィールドの型付けは
 *     サブエージェント側の出力契約が安定した後で段階的に狭めていく。
 *   - critic findings のみは構造を明示して typed にする (重要度でのソート・
 *     overall_assessment 表示に使うため)。
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * deepagents の仮想 FS に書き込まれたファイルの v1 / v2 両フォーマットを
 * 正規化して 1 本の string にする pure 関数。
 *
 * - v1 (legacy): `content: string[]` — 行の配列。`join("\n")` で復元する
 * - v2 (current text): `content: string` — そのまま返す
 * - v2 (binary): `content: Uint8Array` — 監査の raw データは JSON 前提なので
 *   `TextDecoder` で UTF-8 デコードする (画像などの本物の binary は来ない想定
 *    だが、来たら呼び出し側の JSON.parse が throw して早期検出できる)
 *
 * `deepagents/dist/index.d.ts` L267-301 で FileDataV1 / FileDataV2 型を確認済み。
 * `isFileDataV1` ヘルパは top-level export されていないので自前で判別する。
 */
function normalizeFileContent(fileData: unknown): string {
  if (fileData === null || typeof fileData !== "object") {
    throw new Error(
      `expected FileData object, received ${fileData === null ? "null" : typeof fileData}`,
    );
  }
  const content = (fileData as { content?: unknown }).content;
  if (Array.isArray(content)) {
    // v1: `string[]` を改行で復元
    if (!content.every((line) => typeof line === "string")) {
      throw new Error("FileDataV1 content array must contain only strings");
    }
    return content.join("\n");
  }
  if (typeof content === "string") {
    return content;
  }
  if (content instanceof Uint8Array) {
    return new TextDecoder("utf-8").decode(content);
  }
  throw new Error(
    `unsupported FileData content type: ${typeof content} (expected string[] | string | Uint8Array)`,
  );
}

export type AspectRaw = Readonly<Record<string, unknown>>;

export type CriticSeverity = "critical" | "warning" | "info";

export type CriticOverallAssessment = "pass" | "warnings" | "blocked";

export interface CriticFinding {
  readonly severity: CriticSeverity;
  readonly aspect: string;
  readonly message: string;
  readonly evidence?: string;
}

export interface CriticFindings {
  readonly findings: readonly CriticFinding[];
  readonly overall_assessment: CriticOverallAssessment;
}

export interface GenerateAuditReportInput {
  readonly target: {
    readonly owner: string;
    readonly repo: string;
  };
  readonly generatedAt: string;
  readonly license: AspectRaw | null;
  readonly security: AspectRaw | null;
  readonly maintenance: AspectRaw | null;
  readonly apiStability: AspectRaw | null;
  readonly community: AspectRaw | null;
  readonly critic: CriticFindings | null;
}

interface AspectSection {
  readonly key: keyof Pick<
    GenerateAuditReportInput,
    "license" | "security" | "maintenance" | "apiStability" | "community"
  >;
  readonly title: string;
}

const ASPECT_SECTIONS: readonly AspectSection[] = [
  { key: "license", title: "ライセンス" },
  { key: "security", title: "セキュリティ" },
  { key: "maintenance", title: "メンテナンス健全性" },
  { key: "apiStability", title: "API 安定性" },
  { key: "community", title: "コミュニティ採用状況" },
];

/**
 * 5 観点の raw データと critic の findings を統合した Markdown レポートを生成する。
 *
 * この関数は副作用を持たない。呼び出し側 (orchestrator や CLI) が生成された文字列を
 * 仮想 FS や実ファイル (`out/<target>-audit-report.md`) に書き出す責務を持つ。
 */
export function generateAuditReport(input: GenerateAuditReportInput): string {
  const lines: string[] = [];
  const { owner, repo } = input.target;
  const overall = input.critic?.overall_assessment ?? "unknown";

  lines.push(`# ${owner}/${repo} 監査レポート`);
  lines.push("");
  lines.push(`- **対象**: \`${owner}/${repo}\``);
  lines.push(`- **生成日時**: ${input.generatedAt}`);
  lines.push(`- **総合判定**: ${overall}`);
  lines.push("");

  lines.push("## エグゼクティブサマリ");
  lines.push("");
  if (input.critic) {
    const count = input.critic.findings.length;
    lines.push(
      `- 整合性検証: **${input.critic.overall_assessment}** (findings ${count} 件)`,
    );
  } else {
    lines.push("- 整合性検証: *critic 未実行*");
  }
  lines.push("");

  ASPECT_SECTIONS.forEach((section, idx) => {
    const data = input[section.key];
    lines.push(`## ${idx + 1}. ${section.title}`);
    lines.push("");
    if (data === null) {
      lines.push("*raw データ未取得*");
    } else {
      lines.push("```json");
      lines.push(JSON.stringify(data, null, 2));
      lines.push("```");
    }
    lines.push("");
  });

  lines.push(`## ${ASPECT_SECTIONS.length + 1}. 整合性検証 (critic)`);
  lines.push("");
  if (!input.critic) {
    lines.push("*critic 未実行*");
  } else if (input.critic.findings.length === 0) {
    lines.push(
      `総合判定: **${input.critic.overall_assessment}** — 検出された問題はありません。`,
    );
  } else {
    lines.push(`総合判定: **${input.critic.overall_assessment}**`);
    lines.push("");
    lines.push("### Findings");
    lines.push("");
    for (const finding of sortFindingsBySeverity(input.critic.findings)) {
      lines.push(
        `- **[${finding.severity}]** \`${finding.aspect}\` — ${finding.message}`,
      );
      if (finding.evidence !== undefined && finding.evidence !== "") {
        lines.push(`  - 根拠: ${finding.evidence}`);
      }
    }
  }
  lines.push("");

  return lines.join("\n");
}

const SEVERITY_ORDER: Record<CriticSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function sortFindingsBySeverity(
  findings: readonly CriticFinding[],
): CriticFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

/**
 * レポート本文を組み立てて、指定パスに Markdown ファイルとして書き出す。
 *
 * `generateAuditReport` (pure) に fs.writeFile を薄くかぶせたラッパ。出力先の
 * 親ディレクトリが存在しない場合は再帰的に作成するので、呼び出し側は
 * `out/mastra-audit-report.md` のような未作成のパスをそのまま渡せる。
 *
 * オーケストレーション層 (CLI / agent.ts) から呼ばれる想定。ユニットテストは
 * `generateAuditReport` を直接呼び、E2E テストはこのラッパを tmpdir に向けて呼ぶ。
 */
export async function writeAuditReport(
  input: GenerateAuditReportInput,
  outputPath: string,
): Promise<void> {
  const body = generateAuditReport(input);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body, "utf8");
}

/**
 * 各観点 / critic の raw データ JSON が書き出される仮想 FS 上のパス (spec-004 契約)。
 *
 * `AUDIT_SYSTEM_PROMPT` の Phase 1 / Phase 2 の指示と厳密に一致させる必要がある。
 * ここを変えるときは system prompt 側も同時に直さないと agent が書き出した
 * raw を reporter が拾えなくなる。
 */
export const AUDIT_RAW_PATHS = {
  license: "/raw/license/result.json",
  security: "/raw/security/result.json",
  maintenance: "/raw/maintenance/result.json",
  apiStability: "/raw/api-stability/result.json",
  community: "/raw/community/result.json",
  critic: "/raw/critic/findings.json",
} as const;

export type ExtractedAuditRaw = Pick<
  GenerateAuditReportInput,
  "license" | "security" | "maintenance" | "apiStability" | "community" | "critic"
>;

/**
 * `extractAuditRawFromState` が 1 つの raw ファイルで失敗した時に返すエラー情報。
 *
 * `rawString` は元の FileData を正規化した後の文字列で、オーケストレーション層が
 * `out/.state/last-run/` にダンプして目視デバッグできるようにするためのもの。
 * raw が見つからなかった (undefined) ケースはエラーではなく `null` 扱いにする
 * ので、errors 配列には入らない。
 */
export interface AuditRawExtractionError {
  readonly path: string;
  readonly error: string;
  readonly rawString: string | null;
}

export interface ExtractedAuditRawResult {
  readonly data: ExtractedAuditRaw;
  readonly errors: readonly AuditRawExtractionError[];
}

/**
 * `agent.invoke(...)` が返す state から 5 観点の raw データと critic findings を
 * 抽出する pure 関数 (spec-009)。
 *
 * deepagents v1.9 の state は `files?: Record<string, FileData>` を持ち、built-in
 * `write_file` ツールが書き込んだ内容はここに現れる (`deepagents/dist/index.d.ts`
 * L679 / L739)。`CompositeBackend` は default 経路を StateBackend に流すので、
 * `/raw/` プレフィックスのファイルは state 側に来る (routing は `/memories/` /
 * `/skills/` だけが別 backend にハイジャックされる構成)。
 *
 * 抽出方針 (spec-009 初回ランでの失敗経験を反映):
 *   - 各 raw path を個別に取りに行き、見つからなければ `data.<field>=null`
 *     (エラーには**しない**。reporter 側が "未取得" プレースホルダを描画)
 *   - JSON parse や shape 検証で失敗した場合は **errors 配列に詰めるだけ** で
 *     data 側は null にする。throw しない。これにより **critic だけ壊れていても
 *     license/security のレポートは出る** という partial recovery が可能になる
 *   - FileData の v1 / v2 / Uint8Array は `normalizeFileContent` に隠蔽。
 *     `normalizeFileContent` は throw するがそれも catch してエラー化する
 *
 * この関数は pure (副作用なし)。オーケストレーション層が errors を見て stderr に
 * 警告を出したり、state.files を `out/.state/last-run/` にダンプしたりする責務を
 * 負う (run-audit.ts 側の責任)。
 */
export function extractAuditRawFromState(
  state: unknown,
): ExtractedAuditRawResult {
  const files = extractFilesRecord(state);
  const errors: AuditRawExtractionError[] = [];
  const data: ExtractedAuditRaw = {
    license: readAspectRaw(files, AUDIT_RAW_PATHS.license, errors),
    security: readAspectRaw(files, AUDIT_RAW_PATHS.security, errors),
    maintenance: readAspectRaw(files, AUDIT_RAW_PATHS.maintenance, errors),
    apiStability: readAspectRaw(files, AUDIT_RAW_PATHS.apiStability, errors),
    community: readAspectRaw(files, AUDIT_RAW_PATHS.community, errors),
    critic: readCriticFindings(files, AUDIT_RAW_PATHS.critic, errors),
  };
  return { data, errors };
}

function extractFilesRecord(state: unknown): Record<string, unknown> {
  if (state === null || typeof state !== "object") return {};
  const files = (state as { files?: unknown }).files;
  if (files === null || typeof files !== "object") return {};
  return files as Record<string, unknown>;
}

function safeNormalize(fileData: unknown): string | null {
  try {
    return normalizeFileContent(fileData);
  } catch {
    return null;
  }
}

function readAspectRaw(
  files: Record<string, unknown>,
  path: string,
  errors: AuditRawExtractionError[],
): AspectRaw | null {
  const fileData = files[path];
  if (fileData === undefined) return null;
  const raw = safeNormalize(fileData);
  if (raw === null) {
    try {
      normalizeFileContent(fileData);
    } catch (error) {
      errors.push({
        path,
        error: error instanceof Error ? error.message : String(error),
        rawString: null,
      });
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push({
        path,
        error: `expected an object at ${path}, received ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        rawString: raw,
      });
      return null;
    }
    return parsed as AspectRaw;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({
      path,
      error: `failed to parse ${path}: ${message}`,
      rawString: raw,
    });
    return null;
  }
}

function readCriticFindings(
  files: Record<string, unknown>,
  path: string,
  errors: AuditRawExtractionError[],
): CriticFindings | null {
  const fileData = files[path];
  if (fileData === undefined) return null;
  const raw = safeNormalize(fileData);
  if (raw === null) {
    try {
      normalizeFileContent(fileData);
    } catch (error) {
      errors.push({
        path,
        error: error instanceof Error ? error.message : String(error),
        rawString: null,
      });
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({
      path,
      error: `failed to parse ${path}: ${message}`,
      rawString: raw,
    });
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push({
      path,
      error: `expected an object at ${path}, received ${Array.isArray(parsed) ? "array" : typeof parsed}`,
      rawString: raw,
    });
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const findings = obj.findings;
  const overall = obj.overall_assessment;
  if (!Array.isArray(findings)) {
    errors.push({
      path,
      error: `${path}: "findings" must be an array`,
      rawString: raw,
    });
    return null;
  }
  if (overall !== "pass" && overall !== "warnings" && overall !== "blocked") {
    errors.push({
      path,
      error: `${path}: "overall_assessment" must be one of "pass" | "warnings" | "blocked"`,
      rawString: raw,
    });
    return null;
  }
  return {
    findings: findings as readonly CriticFinding[],
    overall_assessment: overall,
  };
}
