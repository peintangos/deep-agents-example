import { describe, it, expect } from "vitest";
import {
  generateAuditReport,
  extractAuditRawFromState,
  AUDIT_RAW_PATHS,
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

// FileData v2 (string content) — deepagents v1.9 の write_file が書き出す形式
function fileV2(content: string) {
  return {
    content,
    mimeType: "application/json",
    created_at: "2026-04-14T10:00:00Z",
    modified_at: "2026-04-14T10:00:00Z",
  };
}

// FileData v1 (string[] content) — legacy 互換。`join("\n")` で復元される
function fileV1(lines: string[]) {
  return {
    content: lines,
    created_at: "2026-04-14T10:00:00Z",
    modified_at: "2026-04-14T10:00:00Z",
  };
}

// FileData v2 (Uint8Array content) — binary 扱い。UTF-8 デコードされる
function fileV2Binary(content: string) {
  return {
    content: new TextEncoder().encode(content),
    mimeType: "application/octet-stream",
    created_at: "2026-04-14T10:00:00Z",
    modified_at: "2026-04-14T10:00:00Z",
  };
}

describe("extractAuditRawFromState", () => {
  it("extracts all 6 raw files from a fully populated state (v2 string content)", () => {
    const state = {
      files: {
        [AUDIT_RAW_PATHS.license]: fileV2('{"spdx_id":"MIT"}'),
        [AUDIT_RAW_PATHS.security]: fileV2('{"known_vulnerabilities":[]}'),
        [AUDIT_RAW_PATHS.maintenance]: fileV2('{"release_cadence_days":14}'),
        [AUDIT_RAW_PATHS.apiStability]: fileV2('{"semver":"1.x"}'),
        [AUDIT_RAW_PATHS.community]: fileV2('{"stars":10000}'),
        [AUDIT_RAW_PATHS.critic]: fileV2(
          '{"findings":[],"overall_assessment":"pass"}',
        ),
      },
    };
    const { data, errors } = extractAuditRawFromState(state);
    expect(errors).toEqual([]);
    expect(data.license).toEqual({ spdx_id: "MIT" });
    expect(data.security).toEqual({ known_vulnerabilities: [] });
    expect(data.maintenance).toEqual({ release_cadence_days: 14 });
    expect(data.apiStability).toEqual({ semver: "1.x" });
    expect(data.community).toEqual({ stars: 10000 });
    expect(data.critic).toEqual({
      findings: [],
      overall_assessment: "pass",
    });
  });

  it("returns null for missing raw files without registering errors", () => {
    const state = {
      files: {
        [AUDIT_RAW_PATHS.license]: fileV2('{"spdx_id":"MIT"}'),
      },
    };
    const { data, errors } = extractAuditRawFromState(state);
    expect(errors).toEqual([]);
    expect(data.license).toEqual({ spdx_id: "MIT" });
    expect(data.security).toBeNull();
    expect(data.maintenance).toBeNull();
    expect(data.apiStability).toBeNull();
    expect(data.community).toBeNull();
    expect(data.critic).toBeNull();
  });

  it("normalizes FileData v1 (string[] content) by joining on newlines", () => {
    const state = {
      files: {
        [AUDIT_RAW_PATHS.license]: fileV1(['{', '  "spdx_id": "MIT"', "}"]),
      },
    };
    const { data } = extractAuditRawFromState(state);
    expect(data.license).toEqual({ spdx_id: "MIT" });
  });

  it("normalizes FileData v2 Uint8Array content via UTF-8 decode", () => {
    const state = {
      files: {
        [AUDIT_RAW_PATHS.license]: fileV2Binary('{"spdx_id":"MIT"}'),
      },
    };
    const { data } = extractAuditRawFromState(state);
    expect(data.license).toEqual({ spdx_id: "MIT" });
  });

  it("returns empty (all null) when state has no files key", () => {
    const { data, errors } = extractAuditRawFromState({ messages: [] });
    expect(errors).toEqual([]);
    expect(data.license).toBeNull();
    expect(data.critic).toBeNull();
  });

  it("returns empty (all null) when state is null or primitive", () => {
    expect(extractAuditRawFromState(null).data.license).toBeNull();
    expect(extractAuditRawFromState("nope").data.license).toBeNull();
    expect(extractAuditRawFromState(undefined).data.license).toBeNull();
  });

  it("records an error with the rawString when an aspect raw is invalid JSON", () => {
    const state = {
      files: {
        [AUDIT_RAW_PATHS.license]: fileV2("this is not json"),
      },
    };
    const { data, errors } = extractAuditRawFromState(state);
    expect(data.license).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/raw/license/result.json");
    expect(errors[0]?.error).toMatch(/failed to parse/);
    expect(errors[0]?.rawString).toBe("this is not json");
  });

  it("records an error when an aspect raw is a JSON array (object required)", () => {
    const state = {
      files: {
        [AUDIT_RAW_PATHS.security]: fileV2("[1, 2, 3]"),
      },
    };
    const { data, errors } = extractAuditRawFromState(state);
    expect(data.security).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toMatch(/expected an object.*received array/);
  });

  it("records an error when critic JSON is missing findings array", () => {
    const state = {
      files: {
        [AUDIT_RAW_PATHS.critic]: fileV2('{"overall_assessment":"pass"}'),
      },
    };
    const { data, errors } = extractAuditRawFromState(state);
    expect(data.critic).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toMatch(/findings.*array/);
  });

  it("records an error when critic overall_assessment has an unexpected value", () => {
    const state = {
      files: {
        [AUDIT_RAW_PATHS.critic]: fileV2(
          '{"findings":[],"overall_assessment":"excellent"}',
        ),
      },
    };
    const { data, errors } = extractAuditRawFromState(state);
    expect(data.critic).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toMatch(/overall_assessment/);
  });

  it("returns partial data when only critic is malformed (robustness guarantee)", () => {
    // spec-009 first-run failure mode: all 5 aspect raws valid, critic malformed.
    // Previous throw-based design lost the entire report; now we should get 5
    // valid aspects + null critic + 1 error entry pointing at critic.
    const state = {
      files: {
        [AUDIT_RAW_PATHS.license]: fileV2('{"spdx_id":"MIT"}'),
        [AUDIT_RAW_PATHS.security]: fileV2('{"known_vulnerabilities":[]}'),
        [AUDIT_RAW_PATHS.maintenance]: fileV2('{"release_cadence_days":14}'),
        [AUDIT_RAW_PATHS.apiStability]: fileV2('{"semver":"1.x"}'),
        [AUDIT_RAW_PATHS.community]: fileV2('{"stars":10000}'),
        [AUDIT_RAW_PATHS.critic]: fileV2('{"findings":[{"severity":"warning"' ),
      },
    };
    const { data, errors } = extractAuditRawFromState(state);
    expect(data.license).not.toBeNull();
    expect(data.security).not.toBeNull();
    expect(data.maintenance).not.toBeNull();
    expect(data.apiStability).not.toBeNull();
    expect(data.community).not.toBeNull();
    expect(data.critic).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/raw/critic/findings.json");
  });

  it("accumulates multiple errors when several raws are malformed", () => {
    const state = {
      files: {
        [AUDIT_RAW_PATHS.license]: fileV2("not json"),
        [AUDIT_RAW_PATHS.security]: fileV2("[1]"),
        [AUDIT_RAW_PATHS.maintenance]: fileV2('{"ok":true}'),
      },
    };
    const { data, errors } = extractAuditRawFromState(state);
    expect(data.license).toBeNull();
    expect(data.security).toBeNull();
    expect(data.maintenance).toEqual({ ok: true });
    expect(errors.map((e) => e.path)).toEqual([
      "/raw/license/result.json",
      "/raw/security/result.json",
    ]);
  });

  it("feeds cleanly into generateAuditReport (integration with pure reporter)", () => {
    const state = {
      files: {
        [AUDIT_RAW_PATHS.license]: fileV2('{"spdx_id":"Elastic-2.0"}'),
        [AUDIT_RAW_PATHS.critic]: fileV2(
          '{"findings":[{"severity":"warning","aspect":"license","message":"elastic"}],"overall_assessment":"warnings"}',
        ),
      },
    };
    const { data } = extractAuditRawFromState(state);
    const report = generateAuditReport({
      target: { owner: "mastra-ai", repo: "mastra" },
      generatedAt: "2026-04-14T10:00:00Z",
      ...data,
    });
    expect(report).toContain("# mastra-ai/mastra 監査レポート");
    expect(report).toContain('"spdx_id": "Elastic-2.0"');
    expect(report).toContain("**総合判定**: warnings");
    expect(report).toContain("## 2. セキュリティ\n\n*raw データ未取得*");
  });
});
