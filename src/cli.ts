import { validateGithubRepoArgs } from "./middleware/validate";

export const HELP_TEXT = `deep-agents-example — OSS 監査エージェント CLI

使用方法:
  npx tsx scripts/run-audit.ts [options]

オプション:
  --help, -h             このヘルプを表示
  --invoke <prompt>      任意のプロンプトでエージェントを 1 回だけ呼び出す (動作確認用)
  --target <owner/repo>  監査対象の GitHub リポジトリを指定して監査を実行
                         (例: --target mastra-ai/mastra)

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

/**
 * `--target <owner/repo>` の実行を担うオーケストレータ (spec-009)。
 *
 * `invoker` (任意プロンプト 1 回呼び出し) とは別経路にしたのは 2 つの責務が
 * 別物だから:
 *   - `invoker`: 自由プロンプト → 最後のアシスタントメッセージを文字列で返す
 *   - `auditRunner`: 固定の監査オーケストレーション (agent.invoke + HITL ループ
 *     + state から `/raw/` 抽出 + `writeAuditReport`) を実行して、生成された
 *     レポートファイルのパスと短い summary を返す
 *
 * run-audit.ts (薄い entry 層) が `realAuditRunner` を実装し、runCli は DI 経由で
 * 受け取る。テストでは mock auditRunner を渡すことで runCli 側の経路分岐と
 * エラーハンドリングだけを決定論的に検証できる (実 LLM / reporter 配線は
 * `tests/audit-pipeline.e2e.test.ts` や本スクリプトの実運用で確認する)。
 */
export interface AuditRunResult {
  readonly reportPath: string;
  readonly summary: string;
}

export type AuditRunner = (target: {
  readonly owner: string;
  readonly repo: string;
}) => Promise<AuditRunResult>;

export interface RunCliOptions {
  readonly invoker?: AgentInvoker;
  readonly auditRunner?: AuditRunner;
}

/**
 * `--target <owner/repo>` から監査エージェントへ渡すユーザープロンプトを組み立てる pure 関数。
 *
 * 監査の実オーケストレーション (Phase 0〜2 / 5 観点委譲 / critic / 完了条件) は
 * `AUDIT_SYSTEM_PROMPT` 側に完結しているため、ユーザープロンプトは
 * **対象リポジトリの identity を渡すだけ** で十分。ここに監査の手順を書くと
 * system prompt と二重管理になって drift するため書かない。
 *
 * 出力は `src/agent.ts` の `AUDIT_SYSTEM_PROMPT` Phase 0 で参照される
 * `<owner>-<repo>` 命名規約と揃えるため、owner / repo を明示的に記載する。
 */
export function buildAuditPrompt(owner: string, repo: string): string {
  return `対象 OSS リポジトリ: ${owner}/${repo}

上記のリポジトリに対して監査を実行してください。Phase 0 で過去履歴の有無を確認し、
Phase 1 で 5 観点のサブエージェントに委譲、Phase 2 で critic に整合性検証を委譲する
AUDIT_SYSTEM_PROMPT の手順に従ってください。`;
}

/**
 * `--target` 引数 (`owner/repo` 形式) を parse + validate する pure 関数。
 *
 * 責務分離:
 *   - CLI (ここ): "ちょうど 1 つの `/` で分割できるか" という **形式** のチェック
 *   - validator (`validateGithubRepoArgs`): "owner / repo の **意味的** な妥当性"
 *     (regex ベースの GitHub 命名規則)
 *
 * 重複を避けるため、regex は middleware 側を再利用する。結果として `--target`
 * と middleware の拒否理由が一貫する (CLI 入力時に早期に弾けるものは弾く、
 * それ以外は middleware が弾く) ので、ユーザーのデバッグ経験も揃う。
 */
export type ParseTargetResult =
  | { readonly ok: true; readonly owner: string; readonly repo: string }
  | { readonly ok: false; readonly error: string };

export function parseTargetArg(raw: string): ParseTargetResult {
  const parts = raw.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    return {
      ok: false,
      error: `--target は "owner/repo" 形式で指定してください (受け取った値: "${raw}")`,
    };
  }
  const [owner, repo] = parts as [string, string];
  const validation = validateGithubRepoArgs({ owner, repo });
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  return { ok: true, owner, repo };
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { exitCode: 0, stdout: `${HELP_TEXT}\n`, stderr: "" };
  }

  const hasInvoke = args.includes("--invoke");
  const hasTarget = args.includes("--target");

  // `--invoke` は自由プロンプト、`--target` は定型監査プロンプトを自動生成する。
  // 両立させると「どちらを invoker に渡すか」の優先順位が曖昧になるので明示的に弾く。
  if (hasInvoke && hasTarget) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "error: --invoke と --target は同時に指定できません (--invoke は任意プロンプト、--target は監査用プロンプトを自動生成)。\n",
    };
  }

  if (hasTarget) {
    const targetIndex = args.indexOf("--target");
    const raw = args[targetIndex + 1];
    if (!raw) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "error: --target には owner/repo 形式の値を 1 つ続けて指定してください (例: --target mastra-ai/mastra)。\n",
      };
    }
    const parsed = parseTargetArg(raw);
    if (!parsed.ok) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `error: ${parsed.error}\n`,
      };
    }
    if (!options.auditRunner) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "error: audit runner is not configured.\n",
      };
    }
    try {
      const result = await options.auditRunner({
        owner: parsed.owner,
        repo: parsed.repo,
      });
      // stdout は "どのファイルに生成したか" を明示する 1 行 + invoker summary。
      // CI 等で `out/mastra-audit-report.md` のパスを grep しやすい形で出す。
      const stdout = `Report written to ${result.reportPath}\n${result.summary}\n`;
      return { exitCode: 0, stdout, stderr: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 1,
        stdout: "",
        stderr: `error: audit run failed: ${message}\n`,
      };
    }
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
