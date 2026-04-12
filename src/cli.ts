export const HELP_TEXT = `deep-agents-example — OSS 監査エージェント CLI

使用方法:
  npx tsx scripts/run-audit.ts [options]

オプション:
  --help, -h          このヘルプを表示
  --target <repo>     監査対象の GitHub リポジトリ (例: mastra-ai/mastra)
                      (spec-009 で実装予定)

環境変数:
  ANTHROPIC_API_KEY   必須: Claude API キー
  GITHUB_TOKEN        任意: GitHub API のレート制限緩和に使用

詳細は docs/prds/prd-mastra-audit-agent/prd.md を参照してください。`;

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCli(argv: readonly string[]): CliResult {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { exitCode: 0, stdout: `${HELP_TEXT}\n`, stderr: "" };
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `error: 未対応のオプションです (${args.join(" ")}).\n--help でヘルプを表示できます。\n`,
  };
}
