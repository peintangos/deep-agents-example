import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * spec-007 タスク 2 のフォーマット検証。
 *
 * `skills/report/<style>/SKILL.md` が以下を満たすことを確認する:
 *   1. 物理ファイルとして存在する
 *   2. 先頭が `---` で始まる YAML frontmatter を持つ
 *   3. frontmatter の `name` が親ディレクトリ名と完全一致する
 *      (deepagents の `validateSkillName` 同等の契約)
 *   4. frontmatter に `description` があり、1 文字以上の非空文字列である
 *   5. 本体セクションが `# ` 見出しで始まり、最低限の実質内容 (≥200 文字) を持つ
 *
 * audit skill 側 (`tests/skills-audit.test.ts`) と同じ契約を張ることで、
 * 後続の "skills ディレクトリ登録" タスクで FilesystemBackend / 段階的開示を
 * 配線する際に report 系だけフォーマットずれを起こすことを防ぐ。
 */

const REPORT_SKILL_STYLES = ["zenn-style"] as const;

const SKILLS_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "skills",
  "report",
);

interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(content);
  if (!match) {
    throw new Error("no valid YAML frontmatter (expected leading `---`)");
  }
  const frontmatterStr = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const nameMatch = /^name:\s*(.+?)\s*$/m.exec(frontmatterStr);
  const descMatch = /^description:\s*(.+?)\s*$/m.exec(frontmatterStr);
  if (!nameMatch?.[1]) throw new Error("frontmatter.name is missing");
  if (!descMatch?.[1]) throw new Error("frontmatter.description is missing");
  return {
    name: nameMatch[1],
    description: descMatch[1],
    body,
  };
}

describe("spec-007 report skill files (SKILL.md format contract)", () => {
  for (const style of REPORT_SKILL_STYLES) {
    describe(`skills/report/${style}/SKILL.md`, () => {
      const skillPath = path.join(SKILLS_ROOT, style, "SKILL.md");

      it("exists as a regular file", async () => {
        const info = await stat(skillPath);
        expect(info.isFile()).toBe(true);
      });

      it("has a valid YAML frontmatter with name + description", async () => {
        const content = await readFile(skillPath, "utf8");
        expect(() => parseFrontmatter(content)).not.toThrow();
      });

      it("frontmatter.name matches the parent directory name", async () => {
        const content = await readFile(skillPath, "utf8");
        const fm = parseFrontmatter(content);
        expect(fm.name).toBe(style);
      });

      it("frontmatter.description is non-empty", async () => {
        const content = await readFile(skillPath, "utf8");
        const fm = parseFrontmatter(content);
        expect(fm.description.length).toBeGreaterThan(0);
      });

      it("has a non-empty body section below the frontmatter", async () => {
        const content = await readFile(skillPath, "utf8");
        const fm = parseFrontmatter(content);
        expect(fm.body).toMatch(/^#\s+/);
        expect(fm.body.length).toBeGreaterThan(200);
      });
    });
  }

  describe("zenn-style SKILL.md content contract", () => {
    const skillPath = path.join(SKILLS_ROOT, "zenn-style", "SKILL.md");

    it("mentions だ/である調 as the required voice", async () => {
      const content = await readFile(skillPath, "utf8");
      expect(content).toMatch(/だ\/である調/);
    });

    it("defines a comparison table (Markdown table syntax) in the body", async () => {
      const content = await readFile(skillPath, "utf8");
      // `|` + `---` を含む行が連続するのが Markdown table の条件
      expect(content).toMatch(/\|[^\n]*\|[^\n]*\|\s*\n\|\s*-{3,}/);
    });

    it("covers heading structure guidance (`###` usage)", async () => {
      const content = await readFile(skillPath, "utf8");
      expect(content).toMatch(/###/);
    });
  });

  it("lists exactly the expected report styles (no drift from spec-007)", () => {
    expect(REPORT_SKILL_STYLES).toEqual(["zenn-style"]);
  });
});
