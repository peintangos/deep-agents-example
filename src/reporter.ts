/**
 * 監査レポート生成モジュール。
 *
 * 5 観点のサブエージェントが書き出した raw データと critic の整合性検証結果を
 * 受け取り、Markdown 文字列を組み立てる純粋関数を提供する。
 *
 * 設計方針:
 *   - I/O を持たない pure function にしておくことで、deepagents の仮想 FS 上の
 *     データでも、ユニットテストのモック JSON でも、同じ関数で統合できる。
 *   - サブエージェントの raw データは `Record<string, unknown>` として受け取り、
 *     未知のフィールドも失わずに JSON ブロックで埋め込む。個別フィールドの型付けは
 *     サブエージェント側の出力契約が安定した後で段階的に狭めていく。
 *   - critic findings のみは構造を明示して typed にする (重要度でのソート・
 *     overall_assessment 表示に使うため)。
 */

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
