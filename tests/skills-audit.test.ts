import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * spec-007 タスク 1 のフォーマット検証。
 *
 * 各 `skills/audit/<aspect>/SKILL.md` が以下を満たすことを確認する:
 *   1. 物理ファイルとして存在する
 *   2. 先頭が `---` で始まる YAML frontmatter を持つ
 *   3. frontmatter の `name` が親ディレクトリ名と完全一致する
 *      (deepagents の `validateSkillName$1` 同等の契約)
 *   4. frontmatter に `description` があり、1 文字以上の非空文字列である
 *   5. frontmatter 以外の本体セクションが存在する (説明が空の skill を防ぐ)
 *
 * deepagents の SkillsMiddleware が実際に読み込むのは next task (配線) の仕事で、
 * ここでは **物理ファイルとしての形式契約** を固定するのが目的。yaml ライブラリ
 * に直接依存すると fragile なので、`name:` / `description:` の行ベース抽出を
 * 自前で実装して最小の検証に絞る。
 */

const AUDIT_SKILL_ASPECTS = [
  "license",
  "security",
  "maintenance",
  "api-stability",
  "community",
] as const;

const SKILLS_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "skills",
  "audit",
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

describe("spec-007 audit skill files (SKILL.md format contract)", () => {
  for (const aspect of AUDIT_SKILL_ASPECTS) {
    describe(`skills/audit/${aspect}/SKILL.md`, () => {
      const skillPath = path.join(SKILLS_ROOT, aspect, "SKILL.md");

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
        expect(fm.name).toBe(aspect);
      });

      it("frontmatter.description is non-empty", async () => {
        const content = await readFile(skillPath, "utf8");
        const fm = parseFrontmatter(content);
        expect(fm.description.length).toBeGreaterThan(0);
      });

      it("has a non-empty body section below the frontmatter", async () => {
        const content = await readFile(skillPath, "utf8");
        const fm = parseFrontmatter(content);
        // 本体がトップレベル heading + 最低 200 文字程度の実質内容を持つことを確認
        // (スケルトンだけの skill を防ぐための境界値)
        expect(fm.body).toMatch(/^#\s+/);
        expect(fm.body.length).toBeGreaterThan(200);
      });
    });
  }

  it("lists exactly the 5 expected audit aspects (no drift from spec-007)", () => {
    expect(AUDIT_SKILL_ASPECTS).toEqual([
      "license",
      "security",
      "maintenance",
      "api-stability",
      "community",
    ]);
  });
});
