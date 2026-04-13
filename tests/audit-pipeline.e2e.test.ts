import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  writeAuditReport,
  type GenerateAuditReportInput,
} from "../src/reporter";

/**
 * spec-004 の受け入れ条件を満たす最小 E2E テスト。
 *
 * モック raw データ (5 観点 + critic findings) を writeAuditReport に渡し、
 * 実ファイルとして tmpdir の `out/mastra-audit-report.md` に書き出す。
 * その後、書き出されたファイルを読み戻し、5 観点セクションと critic findings
 * セクションを含むことを検証する。
 *
 * このテストはサブエージェントや OpenRouter API を実行しない。代わりに
 * 「サブエージェントが書き出したはずの raw データ」をモックとして与えることで、
 * レポート生成パイプラインそのもの (pure 関数 + ファイル I/O) を分離して検証する。
 * LLM 呼び出しを伴う本物の E2E は spec-009 で別途行う。
 */
describe("audit pipeline E2E: mock raw data → on-disk Markdown report", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "audit-pipeline-e2e-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  function mockInput(): GenerateAuditReportInput {
    return {
      target: { owner: "mastra-ai", repo: "mastra" },
      generatedAt: "2026-04-14T00:00:00Z",
      license: {
        spdx_id: "Elastic-2.0",
        license_name: "Elastic License 2.0",
        commercial_use: "restricted",
        compatibility_concerns: ["SaaS 配布時の制約"],
        notes: "license.spdx_id を GitHub メタデータから取得",
      },
      security: {
        known_vulnerabilities: [],
        osv_batch_queries: 12,
        notes: "OSV にマッチする既知脆弱性は 0 件",
      },
      maintenance: {
        release_cadence_days: 14,
        open_issue_count: 120,
        issue_response_median_hours: 36,
        health: "healthy",
      },
      apiStability: {
        semver: "pre-1.0",
        breaking_changes_last_90d: 3,
        notes: "メジャーバージョン未達のため BC は想定範囲内",
      },
      community: {
        stars: 12000,
        contributors: 150,
        recent_contributors_30d: 22,
      },
      critic: {
        overall_assessment: "warnings",
        findings: [
          {
            severity: "warning",
            aspect: "license",
            message:
              "Elastic License 2.0 は商用 SaaS での再配布に制約があるため、採用判断時は法務確認が必要",
            evidence: "license.commercial_use = restricted",
          },
          {
            severity: "info",
            aspect: "api-stability",
            message: "pre-1.0 で 90 日以内に 3 件の BC あり",
            evidence: "apiStability.breaking_changes_last_90d = 3",
          },
        ],
      },
    };
  }

  it("writes out/mastra-audit-report.md containing all 5 aspect sections and the findings section", async () => {
    const outputPath = path.join(workdir, "out", "mastra-audit-report.md");

    await writeAuditReport(mockInput(), outputPath);

    const info = await stat(outputPath);
    expect(info.isFile()).toBe(true);

    const content = await readFile(outputPath, "utf8");
    expect(content).toContain("# mastra-ai/mastra 監査レポート");
    expect(content).toContain("## 1. ライセンス");
    expect(content).toContain("## 2. セキュリティ");
    expect(content).toContain("## 3. メンテナンス健全性");
    expect(content).toContain("## 4. API 安定性");
    expect(content).toContain("## 5. コミュニティ採用状況");
    expect(content).toContain("## 6. 整合性検証 (critic)");
    expect(content).toContain("### Findings");
    expect(content).toContain("Elastic License 2.0 は商用 SaaS");
  });

  it("embeds raw data as JSON code blocks so no field is silently dropped", async () => {
    const outputPath = path.join(workdir, "out", "mastra-audit-report.md");
    await writeAuditReport(mockInput(), outputPath);

    const content = await readFile(outputPath, "utf8");
    expect(content).toContain("```json");
    expect(content).toContain('"spdx_id": "Elastic-2.0"');
    expect(content).toContain('"osv_batch_queries": 12');
    expect(content).toContain('"recent_contributors_30d": 22');
  });

  it("creates intermediate directories when the output path parent does not yet exist", async () => {
    const outputPath = path.join(
      workdir,
      "deeply",
      "nested",
      "out",
      "report.md",
    );

    await writeAuditReport(mockInput(), outputPath);

    const info = await stat(outputPath);
    expect(info.isFile()).toBe(true);
  });

  it("is idempotent: running the pipeline twice overwrites the same file with identical content", async () => {
    const outputPath = path.join(workdir, "out", "mastra-audit-report.md");

    await writeAuditReport(mockInput(), outputPath);
    const first = await readFile(outputPath, "utf8");

    await writeAuditReport(mockInput(), outputPath);
    const second = await readFile(outputPath, "utf8");

    expect(second).toBe(first);
  });
});
