import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { newRun, runOk, runError } from "../../agents/run-record.ts";
import { runAgent, type ReadAgentRunner } from "../../agents/spawn.ts";
import { explore, type ExploreAgentRequest, type ExploreDependencies } from "../../controller/explore.ts";
import { HarnessError } from "../../shared/errors.ts";
import type { AgentRunObserver } from "../agent-progress.ts";
import type { CommandOutcome } from "../command.ts";
import { resolveModelStack, roleModel } from "../models.ts";

// A single read-only exploration turn is interactive, not a long build — cap well
// under the legacy 8h child-timeout floor.
const EXPLORE_CHILD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The explore agent's model, resolved with the same precedence every other role uses:
 * `MUSTER_EXPLORE_MODEL`/`MUSTER_ARCHITECT_MODEL` override > --fh-config YAML's architect
 * slot > --architect flag > the single declared architect fallback.
 */
export function resolveExploreModel(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string {
  return roleModel(resolveModelStack(argv, env), "architect");
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
    runChild?: ReadAgentRunner;
  } = {},
): ExploreDependencies {
  return {
    async runAgent(request) {
      const stack = resolveModelStack(options.argv);
      const slot = stack.architect;
      const model = slot.model;
      const run = newRun("ARCHITECT", model, { ...slot, model });
      const runId = `explore-${randomUUID()}`;
      await (options.runChild ?? runAgent)({
        access: "read",
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

export interface ProductionExplorationOptions {
  cwd: string;
  prompt: string;
  onAgentStart?: AgentRunObserver;
  signal?: AbortSignal;
  argv?: readonly string[];
}

export async function runProductionExploration(
  options: ProductionExplorationOptions,
): Promise<CommandOutcome> {
  const exploration = await explore(
    { prompt: options.prompt },
    createProductionExploreDependencies(options.cwd, options.signal, {
      argv: options.argv,
      onAgentStart: options.onAgentStart,
    }),
  );
  return { status: "success", action: "explore", summary: exploration.analysis.content };
}
