import { describe, it, expect } from "vitest";
import {
  generateAuditReport,
  type GenerateAuditReportInput,
  type CriticFindings,
} from "../src/reporter";

function baseInput(
  overrides: Partial<GenerateAuditReportInput> = {},
): GenerateAuditReportInput {
  return {
    target: { owner: "mastra-ai", repo: "mastra" },
    generatedAt: "2026-04-13T12:00:00Z",
    license: { spdx_id: "Elastic-2.0", commercial_use: "restricted" },
    security: { known_vulnerabilities: [], notes: "OSV clean" },
    maintenance: { release_cadence_days: 14, issue_health: "healthy" },
    apiStability: { semver: "pre-1.0", breaking_changes_last_90d: 3 },
    community: { stars: 12000, contributors: 150 },
    critic: {
      findings: [
        {
          severity: "warning",
          aspect: "license",
          message: "Elastic License は商用 SaaS での配布に制約がある",
          evidence: "license.commercial_use = restricted",
        },
      ],
      overall_assessment: "warnings",
    },
    ...overrides,
  };
}

describe("generateAuditReport", () => {
  it("renders a title with the target repository", () => {
    const report = generateAuditReport(baseInput());
    expect(report).toContain("# mastra-ai/mastra 監査レポート");
  });

  it("includes all 5 aspect sections and the critic section", () => {
    const report = generateAuditReport(baseInput());
    expect(report).toContain("## 1. ライセンス");
    expect(report).toContain("## 2. セキュリティ");
    expect(report).toContain("## 3. メンテナンス健全性");
    expect(report).toContain("## 4. API 安定性");
    expect(report).toContain("## 5. コミュニティ採用状況");
    expect(report).toContain("## 6. 整合性検証 (critic)");
  });

  it("embeds raw JSON data for each aspect in fenced code blocks", () => {
    const report = generateAuditReport(baseInput());
    expect(report).toContain("```json");
    expect(report).toContain('"spdx_id": "Elastic-2.0"');
    expect(report).toContain('"known_vulnerabilities"');
    expect(report).toContain('"release_cadence_days"');
  });

  it("renders overall_assessment in header and executive summary", () => {
    const report = generateAuditReport(baseInput());
    expect(report).toContain("**総合判定**: warnings");
    expect(report).toContain("整合性検証: **warnings** (findings 1 件)");
  });

  it("renders critic findings as a bulleted list with severity labels", () => {
    const report = generateAuditReport(baseInput());
    expect(report).toContain("### Findings");
    expect(report).toContain(
      "- **[warning]** `license` — Elastic License は商用 SaaS での配布に制約がある",
    );
    expect(report).toContain(
      "- 根拠: license.commercial_use = restricted",
    );
  });

  it("sorts findings by severity (critical > warning > info)", () => {
    const critic: CriticFindings = {
      overall_assessment: "blocked",
      findings: [
        { severity: "info", aspect: "community", message: "info msg" },
        { severity: "critical", aspect: "security", message: "critical msg" },
        { severity: "warning", aspect: "license", message: "warn msg" },
      ],
    };
    const report = generateAuditReport(baseInput({ critic }));
    const criticalIdx = report.indexOf("critical msg");
    const warnIdx = report.indexOf("warn msg");
    const infoIdx = report.indexOf("info msg");
    expect(criticalIdx).toBeGreaterThan(-1);
    expect(criticalIdx).toBeLessThan(warnIdx);
    expect(warnIdx).toBeLessThan(infoIdx);
  });

  it("shows a pass summary when critic has zero findings", () => {
    const report = generateAuditReport(
      baseInput({
        critic: { overall_assessment: "pass", findings: [] },
      }),
    );
    expect(report).toContain(
      "総合判定: **pass** — 検出された問題はありません。",
    );
    expect(report).not.toContain("### Findings");
  });

  it("handles missing raw data gracefully with a placeholder", () => {
    const report = generateAuditReport(
      baseInput({
        license: null,
        security: null,
      }),
    );
    expect(report).toContain("## 1. ライセンス\n\n*raw データ未取得*");
    expect(report).toContain("## 2. セキュリティ\n\n*raw データ未取得*");
  });

  it("handles missing critic with an unknown overall and executed placeholder", () => {
    const report = generateAuditReport(baseInput({ critic: null }));
    expect(report).toContain("**総合判定**: unknown");
    expect(report).toContain("整合性検証: *critic 未実行*");
    expect(report).toContain("## 6. 整合性検証 (critic)\n\n*critic 未実行*");
  });

  it("produces a deterministic output for the same input", () => {
    const a = generateAuditReport(baseInput());
    const b = generateAuditReport(baseInput());
    expect(a).toBe(b);
  });
});
