import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph-checkpoint";
import {
  CompositeBackend,
  FilesystemBackend,
  StateBackend,
  StoreBackend,
} from "deepagents";
import {
  createAuditAgent,
  DEFAULT_INTERRUPT_ON,
  DEFAULT_MODEL_NAME,
  DEFAULT_SKILL_SOURCES,
  DEFAULT_SKILLS_ROOT_DIR,
  OPENROUTER_BASE_URL,
  AUDIT_SYSTEM_PROMPT,
} from "../src/agent";

describe("deepagents smoke test", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    // ChatOpenAI のコンストラクタは API キーが無いと実 API 呼び出し前に fail する
    // 可能性があるため、テスト用のダミーキーを注入しておく。実 API 呼び出しはしない。
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it("exports the OpenRouter + GPT-4.1 configuration", () => {
    expect(DEFAULT_MODEL_NAME).toBe("openai/gpt-4.1");
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("creates a deep agent without throwing (requires dummy API key)", () => {
    const agent = createAuditAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
  });

  it("throws a helpful error when OPENROUTER_API_KEY is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => createAuditAgent()).toThrow(/OPENROUTER_API_KEY/);
  });

  it("throws when the API key still contains the placeholder marker", () => {
    process.env.OPENROUTER_API_KEY = "<paste-your-openrouter-api-key-here>";
    expect(() => createAuditAgent()).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("AUDIT_SYSTEM_PROMPT orchestration structure", () => {
  it("names all 6 sub agents so the orchestrator can delegate via task", () => {
    expect(AUDIT_SYSTEM_PROMPT).toContain("license-analyzer");
    expect(AUDIT_SYSTEM_PROMPT).toContain("security-auditor");
    expect(AUDIT_SYSTEM_PROMPT).toContain("maintenance-health");
    expect(AUDIT_SYSTEM_PROMPT).toContain("api-stability");
    expect(AUDIT_SYSTEM_PROMPT).toContain("community-adoption");
    expect(AUDIT_SYSTEM_PROMPT).toContain("critic");
  });

  it("describes the 2-phase ordering (audit before critic)", () => {
    const auditPhaseIdx = AUDIT_SYSTEM_PROMPT.indexOf("Phase 1");
    const criticPhaseIdx = AUDIT_SYSTEM_PROMPT.indexOf("Phase 2");
    expect(auditPhaseIdx).toBeGreaterThan(-1);
    expect(criticPhaseIdx).toBeGreaterThan(auditPhaseIdx);
    expect(AUDIT_SYSTEM_PROMPT).toMatch(
      /Phase 1 が終わる前に\s*\n?\s*critic を呼んではいけません/,
    );
  });

  it("lists all 6 completion-condition raw paths", () => {
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/license/result.json");
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/security/result.json");
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/maintenance/result.json");
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/api-stability/result.json");
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/community/result.json");
    expect(AUDIT_SYSTEM_PROMPT).toContain("/raw/critic/findings.json");
  });

  it("tells the agent not to build the final Markdown itself (reporter does)", () => {
    expect(AUDIT_SYSTEM_PROMPT).toContain("src/reporter.ts");
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/Markdown を\s*\n?\s*組み立てません/);
  });

  it("documents the fact-only principle", () => {
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/ファクト|推測/);
  });

  it("instructs the agent to consult prior history at /memories/history/<owner>-<repo>-<yyyy-mm>.json", () => {
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/Phase 0/);
    expect(AUDIT_SYSTEM_PROMPT).toContain(
      "/memories/history/<owner>-<repo>-<yyyy-mm>.json",
    );
  });

  it("tells the agent to continue the audit even when no prior history exists", () => {
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/履歴.*存在しなくても.*続行/s);
  });

  it("declares that history file writes are NOT the agent's responsibility (orchestrator owns it)", () => {
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/書き込み.*エージェントの責務ではありません/s);
  });

  it("orders Phase 0 before Phase 1 so prior history is consulted first", () => {
    const phase0Idx = AUDIT_SYSTEM_PROMPT.indexOf("Phase 0");
    const phase1Idx = AUDIT_SYSTEM_PROMPT.indexOf("Phase 1");
    expect(phase0Idx).toBeGreaterThan(-1);
    expect(phase1Idx).toBeGreaterThan(phase0Idx);
  });
});

describe("createAuditAgent store injection (spec-005)", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it("creates an agent without throwing when a custom InMemoryStore is injected", () => {
    const store = new InMemoryStore();
    const agent = createAuditAgent({ store });
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
  });

  it("creates a default InMemoryStore when no store option is passed", () => {
    const agent = createAuditAgent();
    expect(agent).toBeDefined();
  });

  it("allows two agents to share the same store for cross-session /memories/ persistence", () => {
    const sharedStore = new InMemoryStore();
    const agentA = createAuditAgent({ store: sharedStore });
    const agentB = createAuditAgent({ store: sharedStore });
    expect(agentA).toBeDefined();
    expect(agentB).toBeDefined();
    // The actual cross-agent read/write behavior is exercised by the
    // spec-005 integration test that persists data via /memories/ paths.
    // Here we only assert the wiring constructs two valid agents over the
    // same BaseStore instance without throwing.
  });

  it("can persist and retrieve data directly through the injected store (store-level proof)", async () => {
    const store = new InMemoryStore();
    createAuditAgent({ store });

    // deepagents の StoreBackend は `/memories/` 配下の書き込みを LangGraph store に
    // 流すが、その namespace は deepagents 内部で管理されている。ここではその
    // namespace を通さず、store API を直接叩くことで「注入された store が
    // 書き込み可能な生きたインスタンスである」最低限の証跡を残す。
    await store.put(["test-namespace"], "key1", { hello: "world" });
    const item = await store.get(["test-namespace"], "key1");
    expect(item?.value).toEqual({ hello: "world" });
  });
});

describe("createAuditAgent HITL wiring (spec-006)", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it("creates an agent with an injected checkpointer without throwing", () => {
    const checkpointer = new MemorySaver();
    const agent = createAuditAgent({ checkpointer });
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
  });

  it("creates a default MemorySaver when no checkpointer option is passed", () => {
    // interruptOn をデフォルト (= HITL 有効) のまま、checkpointer 省略で agent が
    // 生成できることを検証する。checkpointer が無いと HITL middleware が
    // state を保てず実行時に落ちるが、デフォルトで MemorySaver が注入されて
    // いれば生成時点では throw しない。
    const agent = createAuditAgent();
    expect(agent).toBeDefined();
  });

  it("accepts a custom interruptOn map for tests that want to disable HITL", () => {
    // interruptOn: {} を渡すと実質 HITL 無効。HITL を使わないサブエージェント単体
    // テストや future spec で「配線だけ残して中断は止めたい」ケースで使う。
    const agent = createAuditAgent({ interruptOn: {} });
    expect(agent).toBeDefined();
  });

  it("exposes DEFAULT_INTERRUPT_ON with exactly the two external-API tools", () => {
    expect(Object.keys(DEFAULT_INTERRUPT_ON).sort()).toEqual([
      "fetch_github",
      "query_osv",
    ]);
  });

  it("does NOT include write_file in DEFAULT_INTERRUPT_ON (would block /raw/ writes)", () => {
    // write_file を中断対象に含めると、各サブエージェントが /raw/<aspect>/result.json
    // を書こうとするたびに中断がかかり、監査が事実上進まなくなる。将来 write_file
    // の中断が必要になったときは「パス引数でフィルタする description factory」を
    // 用意するなど別戦略が必要 — ここでの選択が将来のトリガーになるよう明示する。
    expect(DEFAULT_INTERRUPT_ON).not.toHaveProperty("write_file");
    expect(DEFAULT_INTERRUPT_ON).not.toHaveProperty("read_file");
  });

  it("configures each HITL tool with approve/reject decisions and a Japanese description", () => {
    for (const [toolName, config] of Object.entries(DEFAULT_INTERRUPT_ON)) {
      expect(config.allowedDecisions).toEqual(["approve", "reject"]);
      expect(typeof config.description).toBe("string");
      // 日本語 (CJK 文字) を含むこと。description に英文が紛れ込むのを防ぐ。
      expect(config.description as string).toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
      expect(toolName).toMatch(/^(fetch_github|query_osv)$/);
    }
  });
});

/**
 * spec-007 Skills 配線検証.
 *
 * `createAuditAgent()` が `createDeepAgent` に渡す backend と skills オプションが
 * 期待どおりの形になっているかを多段で検証する。agent インスタンス自体はコンパイル済み
 * LangGraph なので middleware 設定を直接覗けない。そのため検証は 3 層で行う:
 *
 *   1. **Exports 契約**: `DEFAULT_SKILLS_ROOT_DIR` / `DEFAULT_SKILL_SOURCES` が
 *      物理実体と矛盾なく定義されていることを確認。
 *   2. **配線スモーク**: `createAuditAgent()` が skill 関連オプション (デフォルト / 明示 /
 *      空 / カスタムルート) のすべてで throw せずに agent を生成できることを確認。
 *   3. **ルーティング契約**: `createAuditAgent` が組み立てるのと等価な
 *      CompositeBackend を test 側で組み立て、`/skills/audit/license/SKILL.md` を
 *      仮想パスで read したときに実ファイルの内容が返ってくることを確認。これが
 *      「agent が virtual path 経由で SKILL.md を読める」ことの最低限の証跡。
 *
 * 実際の SkillsMiddleware がメタデータを system prompt に注入する挙動の検証は、
 * spec-007 の 4 つ目のタスク (段階的開示テスト) で fakeModel を使って行う。
 */
describe("createAuditAgent skills wiring (spec-007)", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  describe("exports contract", () => {
    it("DEFAULT_SKILLS_ROOT_DIR points at a real directory inside the repo", async () => {
      const info = await stat(DEFAULT_SKILLS_ROOT_DIR);
      expect(info.isDirectory()).toBe(true);
      // 安全網: 絶対パスで、かつリポジトリ直下の `skills` を末尾に持つ
      expect(path.isAbsolute(DEFAULT_SKILLS_ROOT_DIR)).toBe(true);
      expect(DEFAULT_SKILLS_ROOT_DIR).toMatch(/[\\/]skills$/);
    });

    it("DEFAULT_SKILLS_ROOT_DIR contains both audit/ and report/ subdirectories", async () => {
      const auditInfo = await stat(path.join(DEFAULT_SKILLS_ROOT_DIR, "audit"));
      const reportInfo = await stat(
        path.join(DEFAULT_SKILLS_ROOT_DIR, "report"),
      );
      expect(auditInfo.isDirectory()).toBe(true);
      expect(reportInfo.isDirectory()).toBe(true);
    });

    it("DEFAULT_SKILL_SOURCES lists exactly the two top-level virtual sources", () => {
      expect([...DEFAULT_SKILL_SOURCES]).toEqual([
        "/skills/audit/",
        "/skills/report/",
      ]);
    });
  });

  describe("construction smoke (no invoke)", () => {
    it("creates an agent with default skill wiring (DEFAULT_SKILL_SOURCES + DEFAULT_SKILLS_ROOT_DIR)", () => {
      const agent = createAuditAgent();
      expect(agent).toBeDefined();
      expect(typeof agent.invoke).toBe("function");
    });

    it("accepts an explicit skills array (subset)", () => {
      const agent = createAuditAgent({ skills: ["/skills/audit/"] });
      expect(agent).toBeDefined();
    });

    it("accepts an empty skills array (skills effectively disabled)", () => {
      // skill 無効化モードでの構成確認。配線パスだけ残して metadata 注入を
      // 止めたい既存テスト (例: HITL / store 単体試験) の保険にもなる。
      const agent = createAuditAgent({ skills: [] });
      expect(agent).toBeDefined();
    });

    it("accepts a custom skillsRootDir without touching the repo skills/ directory", async () => {
      // tmpdir に最小の SKILL.md を 1 つだけ置いた "sandbox" を作り、
      // その skillsRootDir を渡して agent が throw しないことを確認する。
      const tmpRoot = await mkdtemp(
        path.join(tmpdir(), "audit-skills-root-"),
      );
      const sandboxSkill = path.join(tmpRoot, "audit", "sandbox", "SKILL.md");
      await mkdir(path.dirname(sandboxSkill), { recursive: true });
      await writeFile(
        sandboxSkill,
        [
          "---",
          "name: sandbox",
          "description: temporary sandbox skill for test",
          "---",
          "",
          "# Sandbox",
          "",
          "本文。",
        ].join("\n"),
        "utf8",
      );

      const agent = createAuditAgent({ skillsRootDir: tmpRoot });
      expect(agent).toBeDefined();
      expect(typeof agent.invoke).toBe("function");
    });
  });

  describe("backend routing contract (CompositeBackend + FilesystemBackend)", () => {
    /**
     * `createAuditAgent` が渡す factory と同形の CompositeBackend を test 側で
     * 組み立てる。これは agent 内部の backend を差し替えているわけではなく、
     * 「createAuditAgent が組んでいるのと同じオブジェクト構造」を test から直接
     * 触って契約を検証しているだけ。プロダクト側の配線コードと test の組み立て
     * コードがずれないよう、両方とも同じ exported constant を使う。
     */
    function buildRoutingLikeAgent(opts: {
      skillsRootDir?: string;
    } = {}) {
      const skillsRootDir = opts.skillsRootDir ?? DEFAULT_SKILLS_ROOT_DIR;
      return new CompositeBackend(new StateBackend({ state: {} } as never), {
        "/memories/": new StoreBackend(),
        "/skills/": new FilesystemBackend({
          rootDir: skillsRootDir,
          virtualMode: true,
        }),
      });
    }

    /**
     * `readRaw` は `{ data?: FileData; error?: string }` を返す。FileData は
     * 新旧 2 形式の union で content の型が異なる (V1: string[] / V2: string | Uint8Array)。
     * test 側で毎回 narrow するのは冗長なので、ヘルパでエラー branch を expect で
     * 潰し、content を **必ず plain string** に正規化して返す。
     *   - string       → そのまま
     *   - string[] (v1)→ `\n` で join
     *   - Uint8Array   → SKILL.md は text なので UTF-8 デコード (実運用では text 固定)
     */
    async function expectReadRawContent(
      backend: CompositeBackend,
      virtualPath: string,
    ): Promise<string> {
      const raw = await backend.readRaw(virtualPath);
      expect(raw.error).toBeUndefined();
      expect(raw.data).toBeDefined();
      const content = raw.data!.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.join("\n");
      return new TextDecoder().decode(content);
    }

    it("reads a real SKILL.md through the virtual /skills/ path (default rootDir)", async () => {
      const backend = buildRoutingLikeAgent();
      const content = await expectReadRawContent(
        backend,
        "/skills/audit/license/SKILL.md",
      );
      // 現物の SKILL.md と同一内容であることを確認 — routing が prefix を
      // ストリップしたうえで FilesystemBackend に渡せていない場合、この read は
      // エラーか空文字になる。
      const expected = await readFile(
        path.join(DEFAULT_SKILLS_ROOT_DIR, "audit", "license", "SKILL.md"),
        "utf8",
      );
      expect(content).toBe(expected);
    });

    it("reads a real SKILL.md through the virtual /skills/report/zenn-style/ path", async () => {
      // spec-007 で新規に追加した report skill も同じルーティングで読めることを
      // 確認する (audit と report の 2 ソース構成が成立している証跡)。
      const backend = buildRoutingLikeAgent();
      const content = await expectReadRawContent(
        backend,
        "/skills/report/zenn-style/SKILL.md",
      );
      expect(content).toContain("name: zenn-style");
      expect(content).toContain("だ/である調");
    });

    it("routes through a custom skillsRootDir when provided", async () => {
      // tmpdir 下の virtual /skills/ 経由で SKILL.md が読み出せることを確認。
      // これは DI を活かしたテストの骨組みで、次タスク (段階的開示テスト) で
      // そのまま拡張する。
      const tmpRoot = await mkdtemp(
        path.join(tmpdir(), "audit-skills-root-"),
      );
      const skillFile = path.join(
        tmpRoot,
        "audit",
        "fake-aspect",
        "SKILL.md",
      );
      await mkdir(path.dirname(skillFile), { recursive: true });
      const body = [
        "---",
        "name: fake-aspect",
        "description: isolated test skill",
        "---",
        "",
        "# Fake",
        "",
        "本文。",
      ].join("\n");
      await writeFile(skillFile, body, "utf8");

      const backend = buildRoutingLikeAgent({ skillsRootDir: tmpRoot });
      const content = await expectReadRawContent(
        backend,
        "/skills/audit/fake-aspect/SKILL.md",
      );
      expect(content).toBe(body);
    });

    it("rejects path traversal attempts (virtualMode blocks /skills/../escape)", async () => {
      // `virtualMode: true` の resolvePath が `..` セグメントを拒否することの証跡。
      // agent 側から `/skills/../something` のような virtual path を読もうとしても、
      // FilesystemBackend 側で error レスポンスが返る (or 例外) ことを確認。
      const backend = buildRoutingLikeAgent();
      const raw = await backend.readRaw("/skills/../package.json").catch(
        (err: unknown) => ({ error: String(err) }),
      );
      // error branch に落ちることが肝。content が返ったら routing が破綻している。
      expect("error" in raw && raw.error).toBeTruthy();
    });
  });
});
