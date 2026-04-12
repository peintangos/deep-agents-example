import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createAuditAgent,
  DEFAULT_MODEL_NAME,
  OPENROUTER_BASE_URL,
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
