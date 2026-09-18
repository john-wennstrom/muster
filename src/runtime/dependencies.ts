import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { changeRunId, createChangeUsageStore, getActiveChange } from "../persistence/change-usage-store.ts";
import { HarnessError } from "../shared/errors.ts";
import { createExploreHandler } from "../muster/explore.ts";
import { createProposeHandler } from "../muster/propose.ts";
import { createRefineHandler } from "../muster/refine.ts";
import { createReviewHandler } from "../muster/review.ts";
import { createImplementHandler } from "../muster/implement.ts";
import { createResumeHandler } from "../muster/resume.ts";
import { createVerifyHandler } from "../muster/verify.ts";
import { createFinishHandler } from "../muster/finish.ts";
import { createStatusHandler } from "../muster/status.ts";
import type { ChangeCommandDependencies } from "./change-command.ts";
import {
  createCommandRunContext,
  createCommandRunId,
  renderCommandOutcome,
  resolveProductionChange,
  validateChangeSlug,
  type ProductionRuntimeOptions,
  type ResolvedChange,
} from "./command.ts";
import { resolveProductionModelStack } from "./planning.ts";
import {
  loadProductionChangeSnapshot,
  loadProductionChangeUsage,
  recordChangeAgentRuns,
  touchActiveChange,
} from "./snapshot.ts";

export type { ProductionRuntimeOptions };
export {
  loadProductionChangeSnapshot,
  loadProductionChangeUsage,
  recordChangeAgentRuns,
  touchActiveChange,
};

/** Assembles the production `/change` handler for every command by wiring the per-command
 * factories in `src/muster/*.ts` to real OpenSpec/Git/store/broker/child/UI dependencies. */
export function createProductionChangeCommandDependencies(
  options: ProductionRuntimeOptions = {},
): ChangeCommandDependencies {
  const cwd = options.cwd ?? process.cwd();
  const resolvedChanges = new Map<string, ResolvedChange>();
  const resolveChange = async (candidate: string, allowMissing: boolean): Promise<ResolvedChange> => {
    const name = validateChangeSlug(candidate);
    if (options.ports?.resolveChange) {
      return options.ports.resolveChange({ planningHome: cwd, changeName: name, allowMissing });
    }
    const adapter = new OpenSpecAdapter({ cwd, signal: options.signal });
    try {
      const status = await adapter.status(name);
      if (status.changeName !== name) {
        throw new HarnessError(
          "CHANGE_SLUG_COLLISION",
          `OpenSpec resolved ${name} as a different change identity`,
          { requested: name, resolved: status.changeName },
        );
      }
      return resolveProductionChange({
        planningHome: status.planningHome.root,
        changesDirectory: status.planningHome.changesDir,
        changeRoot: status.changeRoot,
        changeName: name,
      });
    } catch (error) {
      if (!allowMissing || !(error instanceof HarnessError) || error.code !== "OPENSPEC_COMMAND_FAILED") throw error;
      return resolveProductionChange({ planningHome: cwd, changeName: name, allowMissing: true });
    }
  };
  return {
    forInvocation(context) {
      return createProductionChangeCommandDependencies({
        ...options,
        cwd: context.cwd ?? cwd,
        signal: context.signal ?? options.signal,
        onAgentStart: context.onAgentStart ?? options.onAgentStart,
      });
    },
    async resolveChangeName(explicit, action) {
      const store = createChangeUsageStore(cwd);
      if (explicit) {
        const change = await resolveChange(explicit, action === "propose");
        resolvedChanges.set(change.name, change);
        return change.name;
      }
      const remembered = await getActiveChange(store);
      if (!remembered) return null;
      const change = await resolveChange(remembered, false);
      resolvedChanges.set(change.name, change);
      return change.name;
    },
    activateChange: (changeName) => (options.ports?.activateChange ?? touchActiveChange)({ ...options, cwd, changeName }),
    async createRunContext(command, context) {
      const change = command.changeName
        ? resolvedChanges.get(command.changeName) ?? await resolveProductionChange({
          planningHome: cwd,
          changeName: command.changeName,
          allowMissing: command.action === "propose",
        })
        : undefined;
      const stack = command.action === "status" ? undefined : resolveProductionModelStack(options.argv);
      const stateful = ["implement", "resume", "verify", "finish"].includes(command.action);
      return createCommandRunContext({
        action: command.action,
        repositoryCwd: cwd,
        planningHome: change?.planningHome ?? cwd,
        change,
        runId: command.action === "status" || command.action === "explore"
          ? undefined
          : stateful && command.changeName
            ? changeRunId(command.changeName)
            : createCommandRunId(command.action, command.changeName),
        models: {
          architect: stack?.architect.model,
          builder: stack?.primaryBuilder.model,
          reviewer: stack?.builders.find((slot) => slot.model !== stack.architect.model)?.model ?? stack?.primaryBuilder.model,
          validator: stack?.architect.model,
        },
        signal: options.signal ?? context.signal,
        output: {
          write(outcome) {
            const rendered = renderCommandOutcome(outcome);
            if (context.sendMessage) context.sendMessage(rendered);
            else context.ui.notify(rendered, outcome.status === "failure" ? "error" : outcome.status === "success" ? "info" : "warning");
          },
        },
      });
    },
    loadSnapshot: (changeName) => (options.ports?.loadSnapshot ?? loadProductionChangeSnapshot)({ ...options, cwd, changeName }),
    loadChangeUsage: (changeName) => (options.ports?.loadUsage ?? loadProductionChangeUsage)({ ...options, cwd, changeName }),
    handlers: {
      explore: createExploreHandler(cwd, options),
      propose: createProposeHandler(cwd, options),
      refine: createRefineHandler(cwd, options),
      review: createReviewHandler(cwd, options),
      implement: createImplementHandler(cwd, options),
      resume: createResumeHandler(cwd, options),
      verify: createVerifyHandler(cwd, options),
      finish: createFinishHandler(cwd, options),
      status: createStatusHandler(cwd, options),
    },
  };
}
