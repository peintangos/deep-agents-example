import { describe, it, expect } from "vitest";
import { createAgent, fakeModel } from "langchain";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  CompositeBackend,
  FilesystemBackend,
  StateBackend,
  createSkillsMiddleware,
} from "deepagents";
import { DEFAULT_SKILLS_ROOT_DIR } from "../src/agent";

/**
 * spec-007 最終タスク: skills の段階的開示 (Progressive Disclosure) を決定論的に検証する。
 *
 * **何を縛るか**:
 *   1. `createSkillsMiddleware` + `CompositeBackend(/skills/ → FilesystemBackend)` の
 *      組み合わせが、source パスに応じて **想定どおりの SKILL.md だけ** をロードする
 *   2. メタデータに含まれる skill 名が期待集合と一致し、**集合の外側は混入しない**
 *      (例: `/skills/audit/` 指定で zenn-style が流れない)
 *   3. `/skills/audit/license/` のように観点単独パスを指定すると 0 skill しか
 *      返らない deepagents v1.9 の contract を **退行ガード** として固定する
 *      (spec-007 実装時に発見した listSkillsFromBackend の 1 階層走査制限)
 *   4. fakeModel が受け取る system message に skill 名が文字列として注入されている
 *      (段階的開示の "metadata は prompt、本体は on-demand" という約束の証跡)
 *
 * **構成戦略**:
 *
 * 重量級の `createDeepAgent` / `createAuditAgent` を使わず、**langchain の
 * `createAgent` + `createSkillsMiddleware` を直接組む**。createDeepAgent は
 * default middleware が豊富で、skillsMetadata 以外の理由で state が変化し、
 * 失敗時の切り分けが難しくなる。本テストで検証したいのは SkillsMiddleware の
 * 単独挙動なので、minimal agent で囲むのが合理的。
 *
 * `tests/hitl-e2e.test.ts` が同じ戦略 (minimal createAgent + fakeModel +
 * middleware 単独検証) を採用しており、"middleware 層の契約は minimal agent で
 * 縛る / 配線は smoke.test.ts で縛る" という本プロジェクトの 2 層テスト戦略に
 * 沿う。
 */

/**
 * 本テストで使う CompositeBackend を組み立てる。構造は `src/agent.ts` の
 * `createAuditAgent` が組むのと同一 (/memories/ → StoreBackend は省略)。
 * test と プロダクト側で同じパターンを参照するため、差分が起きたらどちらかが
 * 壊れたシグナルとして機能する。
 */
function buildBackend(): CompositeBackend {
  return new CompositeBackend(new StateBackend({ state: {} } as never), {
    "/skills/": new FilesystemBackend({
      rootDir: DEFAULT_SKILLS_ROOT_DIR,
      virtualMode: true,
    }),
  });
}

interface SkillMetadataLike {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

interface RunResult {
  readonly skillNames: readonly string[];
  readonly skillsMetadata: readonly SkillMetadataLike[];
  readonly capturedSystemMessage: string;
}

/**
 * 指定 source 群で minimal agent を組み、1 回だけ invoke して metadata を
 * 観察する。fakeModel は受信した system message を clos捕 して返し、テスト側で
 * 注入済みテキストを直接 assert できるようにする。
 */
async function runWithSources(
  sources: readonly string[],
): Promise<RunResult> {
  const backend = buildBackend();

  let capturedSystemMessage = "";
  const model = fakeModel().respond((messages: BaseMessage[]) => {
    for (const m of messages) {
      if (m._getType() === "system") {
        const content = m.content;
        if (typeof content === "string") {
          capturedSystemMessage = content;
        } else if (Array.isArray(content)) {
          // content blocks の場合は text 部分だけ結合
          capturedSystemMessage = content
            .map((block) => {
              if (typeof block === "string") return block;
              if (typeof block === "object" && block !== null && "text" in block) {
                return String((block as { text: unknown }).text ?? "");
              }
              return "";
            })
            .join("\n");
        }
      }
    }
    return new AIMessage("done");
  });

  const agent = createAgent({
    model,
    tools: [],
    systemPrompt: "test agent system prompt",
    middleware: [
      createSkillsMiddleware({
        backend,
        sources: [...sources],
      }),
    ],
  });

  const result = (await agent.invoke({
    messages: [{ role: "user", content: "hi" }],
  })) as { skillsMetadata?: SkillMetadataLike[] };

  const metadata = result.skillsMetadata ?? [];
  const names = metadata.map((m) => m.name).sort();

  return {
    skillNames: names,
    skillsMetadata: metadata,
    capturedSystemMessage,
  };
}

describe("spec-007 skills progressive disclosure (deterministic, fakeModel)", () => {
  describe("source scoping: only related SKILL.md are loaded into metadata", () => {
    it("loads exactly the 5 audit skills when sources = ['/skills/audit/']", async () => {
      const { skillNames } = await runWithSources(["/skills/audit/"]);
      expect(skillNames).toEqual([
        "api-stability",
        "community",
        "license",
        "maintenance",
        "security",
      ]);
      // 集合の外側: report 系の zenn-style は流れない
      expect(skillNames).not.toContain("zenn-style");
    });

    it("loads exactly the 1 report skill when sources = ['/skills/report/']", async () => {
      const { skillNames } = await runWithSources(["/skills/report/"]);
      expect(skillNames).toEqual(["zenn-style"]);
      // 集合の外側: audit 系は流れない
      expect(skillNames).not.toContain("license");
      expect(skillNames).not.toContain("security");
    });

    it("loads all 6 skills when sources = ['/skills/audit/', '/skills/report/'] (main agent scope)", async () => {
      const { skillNames } = await runWithSources([
        "/skills/audit/",
        "/skills/report/",
      ]);
      expect(skillNames).toEqual([
        "api-stability",
        "community",
        "license",
        "maintenance",
        "security",
        "zenn-style",
      ]);
    });

    it("loads 0 skills when sources = ['/skills/audit/license/'] (regression guard for the 1-level traversal constraint)", async () => {
      // deepagents v1.9 の `listSkillsFromBackend` は source パスの直下に存在する
      // サブディレクトリを 1 階層だけ走査し、各サブディレクトリ内の `SKILL.md` を読む。
      // `/skills/audit/license/` はその中身が `SKILL.md` (ファイル) のみで、
      // サブディレクトリを持たないため 0 skill しかロードされない。
      //
      // この挙動は実装当初に誤って各 subagent factory で
      // `["/skills/audit/<aspect>/"]` を指定していた原因で、subagent が silently に
      // 0 skill で動いてしまう不具合を起こしていた。ここでその仕様を **回帰テスト
      // として固定** し、将来誰かが粒度を細かくしようとしたときに同じ罠を踏まない
      // よう警告する役目を持たせる。
      const { skillNames } = await runWithSources(["/skills/audit/license/"]);
      expect(skillNames).toEqual([]);
    });
  });

  describe("system prompt injection: metadata is surfaced to the model (progressive disclosure phase 1)", () => {
    it("injects the 5 audit skill names into the system message when sources = ['/skills/audit/']", async () => {
      const { capturedSystemMessage, skillNames } = await runWithSources([
        "/skills/audit/",
      ]);
      expect(skillNames.length).toBe(5);
      // すべての skill 名が prompt に含まれること。これで "metadata だけを prompt に
      // 晒し、本体は on-demand read_file で読む" という段階的開示の約束を
      // 決定論的に固定できる。
      for (const name of skillNames) {
        expect(capturedSystemMessage).toContain(name);
      }
      // report 系の文字列は prompt に混入しないことを明示。
      expect(capturedSystemMessage).not.toContain("zenn-style");
    });

    it("injects both audit and report skill names when sources include both categories", async () => {
      const { capturedSystemMessage, skillNames } = await runWithSources([
        "/skills/audit/",
        "/skills/report/",
      ]);
      expect(skillNames).toContain("zenn-style");
      expect(capturedSystemMessage).toContain("zenn-style");
      expect(capturedSystemMessage).toContain("license");
    });

    it("does NOT inject any skill name when sources yield 0 skills (regression: single-aspect path)", async () => {
      const { capturedSystemMessage, skillNames } = await runWithSources([
        "/skills/audit/license/",
      ]);
      expect(skillNames).toEqual([]);
      // 0 skill のとき prompt は "No skills available" プレースホルダを含む。
      // skill 名 "license" は metadata に含まれないので prompt にも現れない。
      // (SKILLS_SYSTEM_PROMPT テンプレートは `/skills/audit/license/` の
      // ソースパス自体を "Skills Sources" として表示するため、パスとしての
      // `license` 文字列は含まれうる。ここで assert するのは **skill 名としての
      // license メタデータの description** が含まれないこと。)
      expect(capturedSystemMessage).not.toContain("OSS リポジトリのメインライセンスを特定");
    });
  });

  describe("metadata shape: frontmatter fields survive round-trip to state", () => {
    it("exposes name, description, and path fields on each loaded skill", async () => {
      const { skillsMetadata } = await runWithSources(["/skills/audit/"]);
      expect(skillsMetadata.length).toBe(5);
      for (const meta of skillsMetadata) {
        expect(typeof meta.name).toBe("string");
        expect(typeof meta.description).toBe("string");
        expect(meta.description.length).toBeGreaterThan(0);
        expect(typeof meta.path).toBe("string");
        expect(meta.path).toMatch(/SKILL\.md$/);
      }
    });

    it("preserves the license skill's description from its frontmatter", async () => {
      const { skillsMetadata } = await runWithSources(["/skills/audit/"]);
      const license = skillsMetadata.find((m) => m.name === "license");
      expect(license).toBeDefined();
      // `skills/audit/license/SKILL.md` の frontmatter `description` 先頭の
      // 実物 (OSS リポジトリのメインライセンスを特定...) を固定する。
      expect(license?.description).toContain("OSS");
      expect(license?.description).toContain("ライセンス");
    });

    it("preserves the zenn-style skill's description from its frontmatter", async () => {
      const { skillsMetadata } = await runWithSources(["/skills/report/"]);
      const zenn = skillsMetadata.find((m) => m.name === "zenn-style");
      expect(zenn).toBeDefined();
      expect(zenn?.description).toContain("Zenn");
    });
  });
});
