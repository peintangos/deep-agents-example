import "dotenv/config";
import process from "node:process";
import { runCli, type AgentInvoker } from "../src/cli";
import { createAuditAgent } from "../src/agent";

/**
 * --invoke の実 invoker。deepagents の createDeepAgent() が返すエージェントを
 * 1 回呼び出し、最後のメッセージの content を文字列として返す。
 */
const realInvoker: AgentInvoker = async (prompt) => {
  const agent = createAuditAgent();
  const response = (await agent.invoke({
    messages: [{ role: "user", content: prompt }],
  })) as { messages?: Array<{ content?: unknown }> };

  const messages = response.messages ?? [];
  const last = messages[messages.length - 1];
  const content = last?.content;

  if (typeof content === "string") return content;
  return JSON.stringify(content ?? response, null, 2);
};

const result = await runCli(process.argv, { invoker: realInvoker });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
