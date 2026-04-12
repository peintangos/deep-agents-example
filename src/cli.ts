export const HELP_TEXT = `deep-agents-example — OSS 監査エージェント CLI

使用方法:
  npx tsx scripts/run-audit.ts [options]

オプション:
  --help, -h             このヘルプを表示
  --invoke <prompt>      任意のプロンプトでエージェントを 1 回だけ呼び出す (動作確認用)
  --target <repo>        監査対象の GitHub リポジトリ (例: mastra-ai/mastra)
                         (spec-009 で実装予定)

環境変数 (.env 推奨):
  OPENROUTER_API_KEY     必須: OpenRouter API キー。モデルは openai/gpt-4.1
  GITHUB_TOKEN           任意: GitHub API のレート制限緩和に使用

.env の作り方:
  cp .env.example .env
  # その後 OPENROUTER_API_KEY に https://openrouter.ai/keys で取得したキーを貼り付ける

詳細は docs/prds/prd-mastra-audit-agent/prd.md を参照してください。`;

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type AgentInvoker = (prompt: string) => Promise<string>;

export interface RunCliOptions {
  readonly invoker?: AgentInvoker;
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { exitCode: 0, stdout: `${HELP_TEXT}\n`, stderr: "" };
  }

  const invokeIndex = args.indexOf("--invoke");
  if (invokeIndex !== -1) {
    const prompt = args[invokeIndex + 1];
    if (!prompt) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "error: --invoke にはプロンプト文字列を 1 つ続けて指定してください。\n",
      };
    }
    if (!options.invoker) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "error: agent invoker is not configured.\n",
      };
    }
    try {
      const output = await options.invoker(prompt);
      return { exitCode: 0, stdout: `${output}\n`, stderr: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 1,
        stdout: "",
        stderr: `error: agent invocation failed: ${message}\n`,
      };
    }
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `error: 未対応のオプションです (${args.join(" ")}).\n--help でヘルプを表示できます。\n`,
  };
}
