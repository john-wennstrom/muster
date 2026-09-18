import { resolveChangeAction, type ChangeAction } from "../controller/action-resolver.ts";
import { HarnessError } from "../shared/errors.ts";
import { acceptsArity, changeCommandSpec } from "./commands.ts";
import type { ChangeCommandContext, ChangeCommandDependencies } from "./context.ts";
import { emitOutcome, lifecycleBlocker, renderChangeStatus } from "./outcome.ts";
import { actionUsage, changeUsage, parseChangeCommand, type ParsedChangeCommand } from "./parse.ts";

export type LegacyChangeCommand = "refine" | "implement" | "ship";

const legacyAction: Readonly<Record<LegacyChangeCommand, ChangeAction>> = {
  refine: "refine",
  implement: "implement",
  ship: "finish",
};

export function legacyCommandGuidance(command: LegacyChangeCommand, changeName: string): string {
  return `/${command} is deprecated; prefer /change ${legacyAction[command]} ${changeName}`;
}

export async function dispatchLegacyChangeCommand(
  command: LegacyChangeCommand,
  changeName: string,
  context: ChangeCommandContext,
  dependencies: Pick<ChangeCommandDependencies, "loadSnapshot">,
  handler: () => Promise<void>,
): Promise<void> {
  context.ui.notify(legacyCommandGuidance(command, changeName), "warning");
  const resolution = resolveChangeAction(
    legacyAction[command],
    await dependencies.loadSnapshot(changeName),
  );
  if (!resolution.allowed) {
    const next = resolution.nextAction
      ? `/change ${resolution.nextAction} ${changeName}`
      : `/change status ${changeName}`;
    context.ui.notify(`${resolution.reason}. Next: ${next}`, "warning");
    return;
  }
  await handler();
}

async function runHandler(
  parsed: ParsedChangeCommand,
  changeName: string | undefined,
  context: ChangeCommandContext,
  dependencies: ChangeCommandDependencies,
): Promise<void> {
  const handler = dependencies.handlers[parsed.action];
  if (!handler) {
    throw new HarnessError(
      "COMMAND_HANDLER_MISSING",
      `Production handler configuration is incomplete for /change ${parsed.action}`,
      { action: parsed.action },
    );
  }
  const command = { ...parsed, changeName };
  const run = await dependencies.createRunContext?.(command, context);
  const outcome = await handler(command, run ? { ...context, run } : context);
  if (outcome) emitOutcome(context, outcome);
}

export async function dispatchChangeCommand(
  raw: string,
  context: ChangeCommandContext,
  dependencies: ChangeCommandDependencies,
): Promise<void> {
  const parsed = parseChangeCommand(raw);
  if (!parsed) {
    context.ui.notify(changeUsage, "warning");
    return;
  }
  const spec = changeCommandSpec(parsed.action);
  if (!acceptsArity(spec, parsed.arguments.length)) {
    emitOutcome(context, {
      status: "blocked",
      action: parsed.action,
      changeName: parsed.changeName,
      summary: actionUsage(parsed.action),
      next: parsed.changeName ? `/change status ${parsed.changeName}` : undefined,
    });
    return;
  }

  if (spec.change === "none") {
    await runHandler(parsed, undefined, context, dependencies);
    return;
  }

  const changeName = await dependencies.resolveChangeName(parsed.changeName, parsed.action);
  if (!changeName && spec.change === "required") {
    emitOutcome(context, {
      status: "blocked",
      action: parsed.action,
      summary: `No change resolved. ${changeUsage}`,
      next: "/change propose <change>",
    });
    return;
  }

  if (!spec.lifecycleGated) {
    if (!spec.readOnly && changeName) await dependencies.activateChange?.(changeName);
    await runHandler(parsed, changeName ?? parsed.changeName, context, dependencies);
    return;
  }

  const snapshot = changeName ? await dependencies.loadSnapshot(changeName) : null;
  const resolution = resolveChangeAction(parsed.action, snapshot);
  if (!resolution.allowed) {
    const next = resolution.nextAction && changeName
      ? `/change ${resolution.nextAction} ${changeName}`
      : "/change propose";
    const blocker = lifecycleBlocker(
      parsed.action,
      snapshot,
      resolution.reason ?? "Command prerequisites are not satisfied",
    );
    emitOutcome(context, {
      status: "blocked",
      action: parsed.action,
      changeName: changeName ?? undefined,
      summary: blocker.message,
      next,
      blocker,
    });
    return;
  }
  if (parsed.action === "status" && snapshot && !dependencies.handlers.status) {
    const usage = await dependencies.loadChangeUsage?.(changeName!) ?? null;
    emitOutcome(context, {
      status: "success",
      action: "status",
      changeName: changeName!,
      summary: renderChangeStatus(snapshot, usage),
    });
    return;
  }
  if (!spec.readOnly && changeName) await dependencies.activateChange?.(changeName);
  await runHandler(parsed, changeName ?? parsed.changeName, context, dependencies);
}
