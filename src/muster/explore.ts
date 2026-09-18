import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadModelStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
import { newRun, runOk, runError } from "../../extensions/fusion-harness/modules/runtime.ts";
import { runLegacyReadOnlyChild } from "../agents/legacy-adapter.ts";
import { explore, type ExploreAgentRequest, type ExploreDependencies } from "../controller/explore.ts";
import { HarnessError } from "../shared/errors.ts";
import type { AgentRunObserver } from "../runtime/agent-progress.ts";
import type { ParsedChangeCommand, ChangeCommandContext } from "../runtime/change-command.ts";
import type { CommandOutcome, ProductionRuntimeOptions } from "../runtime/command.ts";
import { resolveProductionModelStack } from "../runtime/planning.ts";

// Last-resort fallback only — used when no --fh-config/--architect is configured and no
// MUSTER_EXPLORE_MODEL override is set. Mirrors fusion-harness's own DEFAULT_ARCHITECT.
const DEFAULT_EXPLORE_MODEL = "anthropic/claude-fable-5";
// A single read-only exploration turn is interactive, not a long build — cap well
// under the legacy 8h child-timeout floor.
const EXPLORE_CHILD_TIMEOUT_MS = 30 * 60 * 1000;

/** Same `--flag value` / `--flag=value` reading fusion-harness.ts uses before pi resolves registered flags. */
function rawCliFlag(name: string, argv: readonly string[]): string {
  const long = `--${name}`;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === long) return argv[index + 1]?.trim() ?? "";
    if (argv[index]!.startsWith(`${long}=`)) return argv[index]!.slice(long.length + 1).trim();
  }
  return "";
}

/**
 * Resolve the explore agent's model with the same precedence fusion-harness uses for its
 * own architect role, so /change explore automatically follows whatever the user already
 * configured and authenticated for /refine, /implement, etc.:
 * `MUSTER_EXPLORE_MODEL` env override > --fh-config YAML's architect slot > --architect
 * legacy flag > a hardcoded default (only reached when nothing else is configured).
 */
export function resolveExploreModel(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string {
  const override = env.MUSTER_EXPLORE_MODEL?.trim();
  if (override) return override;
  const configPath = rawCliFlag("fh-config", argv);
  if (configPath) {
    try {
      return loadModelStack(configPath).architect.model;
    } catch {
      // fall through — an invalid/missing --fh-config here is not explore's job to report
    }
  }
  const architectFlag = rawCliFlag("architect", argv);
  if (architectFlag) return architectFlag;
  return DEFAULT_EXPLORE_MODEL;
}

export function renderExplorePrompt(request: ExploreAgentRequest): string {
  const sections = [request.prompt];
  if (Object.keys(request.authoritativeContext).length > 0) {
    sections.push(`AUTHORITATIVE CONTEXT\n${JSON.stringify(request.authoritativeContext, null, 2)}`);
  }
  if (request.supplementalFacts.length > 0) {
    sections.push(`SUPPLEMENTAL FACTS\n${JSON.stringify(request.supplementalFacts, null, 2)}`);
  }
  return sections.join("\n\n");
}

export function createProductionExploreDependencies(
  cwd: string,
  signal?: AbortSignal,
  options: {
    argv?: readonly string[];
    onAgentStart?: AgentRunObserver;
    runChild?: typeof runLegacyReadOnlyChild;
  } = {},
): ExploreDependencies {
  return {
    async runAgent(request) {
      const stack = resolveProductionModelStack(options.argv);
      const slot = stack.architect;
      const model = resolveExploreModel(process.env, options.argv);
      const run = newRun("ARCHITECT", model, { ...slot, model });
      const runId = `explore-${randomUUID()}`;
      await (options.runChild ?? runLegacyReadOnlyChild)({
        run,
        modelStack: stack,
        onAgentStart: options.onAgentStart,
        prompt: renderExplorePrompt(request),
        systemPrompt: slot.systemPrompt,
        appendSystemPrompts: slot.appendSystemPrompts,
        role: "architect",
        runId,
        childId: "explore",
        taskId: "change.explore",
        description: "Read-only exploration for /change explore",
        assignee: slot.id,
        thinking: slot.thinking,
        sessionDir: resolve(cwd, ".fusion", "runs", runId, "sessions", "explore"),
        cwd,
        timeoutMs: EXPLORE_CHILD_TIMEOUT_MS,
        signal,
      });
      if (run.status === "aborted") {
        throw new HarnessError("PROCESS_CANCELLED", "Exploration cancelled", { runId });
      }
      if (!runOk(run)) {
        throw new HarnessError(
          "EXPLORE_AGENT_FAILED",
          `Explore agent failed: ${runError(run)}`,
          { runId, exitCode: run.exitCode },
        );
      }
      return { model: run.model, content: run.text };
    },
  };
}

/** Builds the `/change explore` handler bound to the given cwd/options closure. */
export function createExploreHandler(cwd: string, options: ProductionRuntimeOptions) {
  return async function exploreHandler(
    command: ParsedChangeCommand & { changeName?: string },
    context: ChangeCommandContext,
  ): Promise<CommandOutcome | void> {
    const prompt = command.arguments.join(" ").trim();
    if (!prompt) {
      return {
        status: "blocked" as const,
        action: "explore" as const,
        summary: "Usage: /change explore <prompt>",
      };
    }
    if (options.runners?.explore) {
      return options.runners.explore({ cwd, prompt, signal: options.signal ?? context.signal });
    }
    const authoritativeContext = command.changeName ? { changeName: command.changeName } : undefined;
    const exploration = await explore(
      { prompt, authoritativeContext },
      createProductionExploreDependencies(cwd, options.signal ?? context.signal, {
        argv: options.argv,
        onAgentStart: context.onAgentStart ?? options.onAgentStart,
      }),
    );
    return {
      status: "success" as const,
      action: "explore" as const,
      summary: exploration.analysis.content,
    };
  };
}
