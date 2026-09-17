import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeSnapshot } from "../controller/change-snapshot.ts";
import {
  resolveChangeAction,
  type ChangeAction,
} from "../controller/action-resolver.ts";
import type { ChangeUsageSummary } from "../persistence/change-usage-store.ts";
import { HOST_EXECUTION_SECURITY_NOTICE } from "../tools/command-profile.ts";

export const changeSubcommands = [
  "explore",
  "propose",
  "refine",
  "review",
  "implement",
  "verify",
  "finish",
  "status",
  "resume",
] as const satisfies readonly ChangeAction[];

const commandSet = new Set<string>(changeSubcommands);
export const changeUsage = [
  `Usage: /change <${changeSubcommands.join("|")}> [change] [arguments]`,
  HOST_EXECUTION_SECURITY_NOTICE,
].join("\n");
export const changeResumeUsage = [
  "Usage: /change resume <change> <checkpoint-id>",
  HOST_EXECUTION_SECURITY_NOTICE,
].join("\n");
export const changeCommandDescription =
  `Correctness-ready beta OpenSpec workflows. ${HOST_EXECUTION_SECURITY_NOTICE}`;

export interface ParsedChangeCommand {
  action: ChangeAction;
  changeName?: string;
  arguments: readonly string[];
}

export interface ChangeCommandContext {
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

export interface ChangeCommandDependencies {
  resolveChangeName(explicit?: string): Promise<string | null>;
  loadSnapshot(changeName: string): Promise<ChangeSnapshot | null>;
  loadChangeUsage?(changeName: string): Promise<ChangeUsageSummary | null>;
  handlers: Partial<Record<ChangeAction, (
    command: ParsedChangeCommand & { changeName?: string },
    context: ChangeCommandContext,
  ) => Promise<void>>>;
}

export type LegacyChangeCommand = "refine" | "implement" | "ship";

const legacyAction: Readonly<Record<LegacyChangeCommand, ChangeAction>> = {
  refine: "refine",
  implement: "implement",
  ship: "finish",
};

export function legacyCommandGuidance(
  command: LegacyChangeCommand,
  changeName: string,
): string {
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

export function parseChangeCommand(raw: string): ParsedChangeCommand | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || !commandSet.has(parts[0]!)) return null;
  return {
    action: parts[0] as ChangeAction,
    changeName: parts[1],
    arguments: parts.slice(2),
  };
}

function renderChangeUsage(usage: ChangeUsageSummary): string[] {
  const costLabel = usage.total.cost.completeness === "unavailable"
    ? "cost unknown"
    : `~$${usage.total.cost.knownUsd.toFixed(4)}${usage.total.cost.completeness === "partial" ? " (partial)" : ""}`;
  const lines = [
    `Usage: ${usage.total.invocations} invocations, ${usage.total.totalTokens.toLocaleString()} tokens, ${costLabel}`,
  ];
  for (const [phase, summary] of Object.entries(usage.byPhase)) {
    if (summary.invocations === 0) continue;
    lines.push(`  ${phase}: ${summary.invocations} invocations, ${summary.totalTokens.toLocaleString()} tokens`);
  }
  return lines;
}

export function renderChangeStatus(snapshot: ChangeSnapshot, usage?: ChangeUsageSummary | null): string {
  return [
    `Change: ${snapshot.changeName}`,
    `Lifecycle: ${snapshot.lifecycle}`,
    `Review: ${snapshot.freshness.review}`,
    `Validation: ${snapshot.freshness.validation}`,
    `Pending checkpoints: ${snapshot.pendingCheckpointIds.length}`,
    ...(usage ? renderChangeUsage(usage) : []),
    HOST_EXECUTION_SECURITY_NOTICE,
  ].join("\n");
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
  if (parsed.action === "resume" && parsed.arguments.length !== 1) {
    context.ui.notify(changeResumeUsage, "warning");
    return;
  }
  const changeName = await dependencies.resolveChangeName(parsed.changeName);
  if (!changeName && !["explore", "propose"].includes(parsed.action)) {
    context.ui.notify(`No change resolved. ${changeUsage}`, "warning");
    return;
  }
  const snapshot = changeName ? await dependencies.loadSnapshot(changeName) : null;
  const resolution = resolveChangeAction(parsed.action, snapshot);
  if (!resolution.allowed) {
    const next = resolution.nextAction && changeName
      ? `/change ${resolution.nextAction} ${changeName}`
      : "/change propose";
    context.ui.notify(`${resolution.reason}. Next: ${next}`, "warning");
    return;
  }
  if (parsed.action === "status" && snapshot && !dependencies.handlers.status) {
    const usage = await dependencies.loadChangeUsage?.(changeName!) ?? null;
    context.ui.notify(renderChangeStatus(snapshot, usage), "info");
    return;
  }
  const handler = dependencies.handlers[parsed.action];
  if (!handler) {
    context.ui.notify(`/${parsed.action} is not available in this build`, "warning");
    return;
  }
  await handler({ ...parsed, changeName: changeName ?? parsed.changeName }, context);
}

export function registerChangeCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  dependencies: ChangeCommandDependencies,
): void {
  pi.registerCommand("change", {
    description: changeCommandDescription,
    handler: async (args, context) => {
      const typedContext = context as ChangeCommandContext;
      try {
        await dispatchChangeCommand(args, typedContext, dependencies);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        typedContext.ui.notify(`/change failed: ${message}`, "error");
      }
    },
  });
}