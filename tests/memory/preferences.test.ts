import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

import {
  DEFAULT_USER_PREFERENCES,
  REPORT_TONES,
  USER_PREFERENCES_MEMORY_PATH,
  normalizePriorityAspects,
  readUserPreferences,
  writeUserPreferences,
  type UserPreferences,
} from "../../src/memory/preferences";
import { writeMemoryJson } from "../../src/memory/store-helpers";

/**
 * spec-005: ユーザー好み (`/memories/user-preferences.json`) ヘルパーのユニットテスト。
 *
 * 監査ポリシーと同じ BaseStore 直結ヘルパーに乗っているので、ここでは
 * preferences 固有のロジック (priorityAspects 正規化, tone 列挙, round-trip)
 * のみを集中検証する。FileData v2 形状や namespace/prefix の規約は
 * `policy.test.ts` 側ですでに固めてある。
 */

describe("UserPreferences constants", () => {
  it("exposes the canonical /memories/ path", () => {
    expect(USER_PREFERENCES_MEMORY_PATH).toBe("/memories/user-preferences.json");
  });

  it("treats the default preferences as an empty object", () => {
    expect(DEFAULT_USER_PREFERENCES).toEqual({});
  });

  it("exposes both formal and polite as supported tones", () => {
    expect(REPORT_TONES).toEqual(["formal", "polite"]);
  });
});

describe("normalizePriorityAspects", () => {
  it("returns undefined when the input is undefined (preserving the unset signal)", () => {
    expect(normalizePriorityAspects(undefined)).toBeUndefined();
  });

  it("returns an empty array when the input is an empty array", () => {
    expect(normalizePriorityAspects([])).toEqual([]);
  });

  it("removes duplicates while preserving first-occurrence order", () => {
    expect(
      normalizePriorityAspects([
        "license",
        "security",
        "license",
        "community",
        "security",
      ]),
    ).toEqual(["license", "security", "community"]);
  });

  it("filters out unknown aspects (e.g. critic, typos from JSON revival)", () => {
    expect(
      normalizePriorityAspects([
        "license",
        // @ts-expect-error — simulate JSON revival of a stale value
        "critic",
        "security",
        // @ts-expect-error — simulate user typo
        "licensing",
      ]),
    ).toEqual(["license", "security"]);
  });
});

describe("readUserPreferences / writeUserPreferences", () => {
  it("returns null when no preferences have been written yet", async () => {
    const store = new InMemoryStore();
    expect(await readUserPreferences(store)).toBeNull();
  });

  it("round-trips a fully populated preferences object", async () => {
    const store = new InMemoryStore();
    const prefs: UserPreferences = {
      tone: "formal",
      priorityAspects: ["security", "license", "maintenance"],
      notes: "プロダクションでの SaaS 配布前提",
    };
    await writeUserPreferences(store, prefs);
    expect(await readUserPreferences(store)).toEqual(prefs);
  });

  it("normalizes priorityAspects on write (dedupe + drop unknown values)", async () => {
    const store = new InMemoryStore();
    await writeUserPreferences(store, {
      tone: "polite",
      priorityAspects: [
        "license",
        "license",
        // @ts-expect-error — simulate caller passing an invalid aspect
        "critic",
        "security",
      ],
    });
    const got = await readUserPreferences(store);
    expect(got).toEqual({
      tone: "polite",
      priorityAspects: ["license", "security"],
    });
  });

  it("normalizes priorityAspects on read when stored data was hand-edited", async () => {
    const store = new InMemoryStore();
    // **意図的に write helper を経由しない** — 手書き編集 / 旧バージョンが書いた
    // 形式 / 別ツールで生成された JSON など、write 側の正規化を通らずに
    // `/memories/user-preferences.json` に投入されるケースを模擬する。
    // これで初めて read 側の normalizePriorityAspects 防御を実走させられる。
    await writeMemoryJson(store, USER_PREFERENCES_MEMORY_PATH, {
      tone: "formal",
      priorityAspects: ["security", "security", "ALL", "license"],
    });
    const got = await readUserPreferences(store);
    expect(got?.priorityAspects).toEqual(["security", "license"]);
    expect(got?.tone).toBe("formal");
  });

  it("preserves a sparse preferences object (only tone)", async () => {
    const store = new InMemoryStore();
    const prefs: UserPreferences = { tone: "polite" };
    await writeUserPreferences(store, prefs);
    expect(await readUserPreferences(store)).toEqual(prefs);
  });

  it("supports overwriting existing preferences (last write wins)", async () => {
    const store = new InMemoryStore();
    await writeUserPreferences(store, { tone: "formal" });
    await writeUserPreferences(store, { tone: "polite", notes: "更新" });
    expect(await readUserPreferences(store)).toEqual({
      tone: "polite",
      notes: "更新",
    });
  });

  it("leaves priorityAspects undefined when the input omits the field (does not coerce to [])", async () => {
    const store = new InMemoryStore();
    await writeUserPreferences(store, { tone: "formal" });
    const got = await readUserPreferences(store);
    expect(got).toEqual({ tone: "formal" });
    expect(got?.priorityAspects).toBeUndefined();
  });
});
