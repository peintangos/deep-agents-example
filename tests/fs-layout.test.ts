import { describe, it, expect } from "vitest";
import {
  AUDIT_ASPECTS,
  FS_PREFIX,
  classifyPath,
  memoryPath,
  rawPath,
  reportPath,
} from "../src/fs-layout";

describe("fs-layout", () => {
  describe("prefixes", () => {
    it("defines the 3 canonical prefixes", () => {
      expect(FS_PREFIX.RAW).toBe("/raw");
      expect(FS_PREFIX.REPORTS).toBe("/reports");
      expect(FS_PREFIX.MEMORIES).toBe("/memories");
    });
  });

  describe("AUDIT_ASPECTS", () => {
    it("enumerates the 6 audit aspects (5 観点 + critic)", () => {
      expect(AUDIT_ASPECTS).toEqual([
        "license",
        "security",
        "maintenance",
        "api-stability",
        "community",
        "critic",
      ]);
    });
  });

  describe("rawPath", () => {
    it("builds /raw/<aspect>/<filename>", () => {
      expect(rawPath("license", "result.json")).toBe("/raw/license/result.json");
    });

    it("supports nested filenames", () => {
      expect(rawPath("security", "cves/osv-2024-1234.json")).toBe(
        "/raw/security/cves/osv-2024-1234.json",
      );
    });

    it("accepts all declared aspects", () => {
      for (const aspect of AUDIT_ASPECTS) {
        expect(rawPath(aspect, "x.json")).toBe(`/raw/${aspect}/x.json`);
      }
    });
  });

  describe("reportPath", () => {
    it("builds /reports/<filename>", () => {
      expect(reportPath("mastra-audit-report.md")).toBe("/reports/mastra-audit-report.md");
    });
  });

  describe("memoryPath", () => {
    it("builds /memories/<filename>", () => {
      expect(memoryPath("audit-policy.json")).toBe("/memories/audit-policy.json");
    });
  });

  describe("classifyPath", () => {
    it("classifies raw paths", () => {
      expect(classifyPath("/raw/license/result.json")).toBe("raw");
    });

    it("classifies report paths", () => {
      expect(classifyPath("/reports/final.md")).toBe("report");
    });

    it("classifies memory paths", () => {
      expect(classifyPath("/memories/policy.json")).toBe("memory");
    });

    it("classifies unknown paths as transient", () => {
      expect(classifyPath("/scratch/temp.txt")).toBe("transient");
    });

    it("does not confuse prefix substring matches", () => {
      expect(classifyPath("/rawbit/data.json")).toBe("transient");
      expect(classifyPath("/reportsX/data.json")).toBe("transient");
      expect(classifyPath("/memorable/data.json")).toBe("transient");
    });

    it("does not classify the bare prefix as raw (missing trailing slash)", () => {
      expect(classifyPath("/raw")).toBe("transient");
    });
  });
});
