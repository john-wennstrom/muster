import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeSnapshot } from "../controller/change-snapshot.ts";
import {
  resolveChangeAction,
  type ChangeAction,
} from "../controller/action-resolver.ts";
import type { ChangeUsageSummary } from "../persistence/change-usage-store.ts";
import { HarnessError } from "../shared/errors.ts";
import { HOST_EXECUTION_SECURITY_NOTICE } from "../tools/command-profile.ts";
import { createAgentProgress, type AgentRunObserver } from "./agent-progress.ts";
import {
  renderCommandOutcome,
  type CommandBlocker,
  type CommandOutcome,
  type CommandRunContext,
} from "./command.ts";

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
  cwd?: string;
  signal?: AbortSignal;
  actor?: string;
  run?: CommandRunContext;
  onAgentStart?: AgentRunObserver;
  /**
   * Post durable Markdown content into the chat transcript. `ui.notify` is a transient
   * toast unsuited to long-form output (e.g. an explore analysis); handlers that produce
   * such content should prefer this and fall back to `ui.notify` when it is unavailable
   * (e.g. in tests).
   */
  sendMessage?(content: string): void;
}

export interface ChangeCommandDependencies {
  forInvocation?(context: ChangeCommandContext): ChangeCommandDependencies | Promise<ChangeCommandDependencies>;
  createRunContext?(
    command: ParsedChangeCommand & { changeName?: string },
    context: ChangeCommandContext,
  ): CommandRunContext | Promise<CommandRunContext>;
  resolveChangeName(explicit?: string, action?: ChangeAction): Promise<string | null>;
  activateChange?(changeName: string): Promise<void>;
  loadSnapshot(changeName: string): Promise<ChangeSnapshot | null>;
  loadChangeUsage?(changeName: string): Promise<ChangeUsageSummary | null>;
  handlers: Partial<Record<ChangeAction, (
    command: ParsedChangeCommand & { changeName?: string },
    context: ChangeCommandContext,
  ) => Promise<CommandOutcome | void>>>;
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
  const action = parts[0] as ChangeAction;
  // explore takes a free-text prompt, not a "[change] [arguments]" pair — the whole
  // remainder is the prompt and there is no change slug to parse out of it.
  if (action === "explore") {
    return { action, changeName: undefined, arguments: parts.slice(1) };
  }
  return {
    action,
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

function emitOutcome(context: ChangeCommandContext, outcome: CommandOutcome): void {
  const rendered = renderCommandOutcome(outcome);
  if (context.sendMessage) context.sendMessage(rendered);
  else context.ui.notify(
    rendered,
    outcome.status === "failure" ? "error" : outcome.status === "success" ? "info" : "warning",
  );
}

function terminalErrorOutcome(error: unknown, parsed: ParsedChangeCommand | null): CommandOutcome {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNEXPECTED_ERROR";
  const cancelled = (error instanceof DOMException && error.name === "AbortError") || errorCode === "PROCESS_CANCELLED";
  if (cancelled) {
    return {
      status: "cancelled",
      action: parsed?.action ?? "status",
      changeName: parsed?.changeName,
      code: errorCode,
      summary: `/change cancelled: ${message}`,
      next: parsed?.changeName ? `/change status ${parsed.changeName}` : undefined,
    };
  }

  const invalidChange = new Set([
    "CHANGE_IDENTIFIER_INVALID",
    "CHANGE_NOT_FOUND",
    "CHANGE_PATH_UNSAFE",
    "CHANGE_SLUG_COLLISION",
  ]).has(errorCode);
  const modelUnavailable = new Set([
    "MODEL_UNAVAILABLE",
    "OPENAI_REQUIRED",
    "COPILOT_ADAPTER_REQUIRED",
    "REVIEW_MODEL_UNAVAILABLE",
  ]).has(errorCode);
  const pendingCheckpoint = new Set([
    "MANUAL_CHECKPOINT_CONFIRMED",
    "MANUAL_CHECKPOINT_INVALID",
    "MANUAL_CHECKPOINT_MISMATCH",
    "MANUAL_RESUME_INVALID",
  ]).has(errorCode);
  const invalidEvidence = errorCode.startsWith("PERSISTENCE_") || new Set([
    "RECOVERY_STATE_CONFLICT",
    "REVIEW_ARTIFACT_INVALID",
    "VERIFICATION_ARTIFACT_INVALID",
    "VERIFICATION_NOT_READY",
    "SNAPSHOT_INCONSISTENT",
    "STATE_OBSERVATION_CONFLICT",
  ]).has(errorCode);
  const externalCapability = new Set([
    "OPENSPEC_CAPABILITY_MISSING",
    "PROCESS_SPAWN_FAILED",
  ]).has(errorCode);
  const blocked = invalidChange || modelUnavailable || pendingCheckpoint || invalidEvidence || externalCapability;
  const checkpointId = error instanceof HarnessError && typeof error.details.checkpointId === "string"
    ? error.details.checkpointId
    : undefined;
  const next = pendingCheckpoint && parsed?.changeName
    ? `/change resume ${parsed.changeName} <checkpoint-id>`
    : invalidChange && errorCode === "CHANGE_NOT_FOUND" && parsed?.changeName
      ? `/change propose ${parsed.changeName}`
      : parsed?.changeName
        ? `/change status ${parsed.changeName}`
        : undefined;
  return {
    status: blocked ? "blocked" : "failure",
    action: parsed?.action ?? "status",
    changeName: parsed?.changeName,
    code: errorCode,
    summary: `/change ${blocked ? "blocked" : "failed"}: ${message}`,
    next,
    blocker: blocked ? {
      kind: invalidChange
        ? "invalid_change"
        : modelUnavailable
          ? "model_unavailable"
          : pendingCheckpoint
            ? "pending_checkpoint"
            : invalidEvidence
              ? "invalid_evidence"
              : "external_capability",
      message,
      checkpointIds: checkpointId ? [checkpointId] : undefined,
    } : undefined,
  };
}

function lifecycleBlocker(
  action: ChangeAction,
  snapshot: ChangeSnapshot | null,
  fallback: string,
): CommandBlocker {
  if (snapshot?.pendingCheckpointIds.length) {
    return {
      kind: "pending_checkpoint",
      message: `Pending manual checkpoint(s): ${snapshot.pendingCheckpointIds.join(", ")}`,
      checkpointIds: snapshot.pendingCheckpointIds,
    };
  }
  if (action === "implement" && snapshot && snapshot.freshness.review !== "current") {
    return {
      kind: snapshot.freshness.review === "stale" ? "stale_digest" : "missing_artifact",
      message: snapshot.freshness.review === "stale"
        ? "Planning review is stale for the current artifact digest"
        : "A current approved review.md is required before implementation",
      artifact: "review.md",
    };
  }
  if (action === "finish" && snapshot && snapshot.freshness.validation !== "current") {
    return {
      kind: snapshot.freshness.validation === "stale" ? "stale_digest" : "missing_artifact",
      message: snapshot.freshness.validation === "stale"
        ? "Verification is stale for the current artifact or source digest"
        : "A current passing verification.md is required before finish",
      artifact: "verification.md",
    };
  }
  return { kind: "lifecycle", message: fallback };
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
  if (parsed.action === "resume" && parsed.arguments.length !== 1) {
    emitOutcome(context, {
      status: "blocked",
      action: "resume",
      changeName: parsed.changeName,
      summary: changeResumeUsage,
      next: parsed.changeName ? `/change resume ${parsed.changeName} <checkpoint-id>` : undefined,
    });
    return;
  }

  if (parsed.action === "explore") {
    await runHandler(parsed, undefined, context, dependencies);
    return;
  }

  const changeName = await dependencies.resolveChangeName(parsed.changeName, parsed.action);
  if (!changeName && parsed.action !== "propose") {
    emitOutcome(context, {
      status: "blocked",
      action: parsed.action,
      summary: `No change resolved. ${changeUsage}`,
      next: "/change propose <change>",
    });
    return;
  }

  if (parsed.action === "propose") {
    if (changeName) await dependencies.activateChange?.(changeName);
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
  if (parsed.action !== "status" && changeName) await dependencies.activateChange?.(changeName);
  await runHandler(parsed, changeName ?? parsed.changeName, context, dependencies);
}

const CHANGE_MESSAGE_TYPE = "muster-change";

export function registerChangeCommand(
  pi: Pick<ExtensionAPI, "registerCommand" | "sendMessage">,
  dependencies: ChangeCommandDependencies,
): void {
  pi.registerCommand("change", {
    description: changeCommandDescription,
    handler: async (args, context) => {
      const typedContext: ChangeCommandContext = {
        ui: context.ui,
        cwd: context.cwd,
        signal: context.signal,
        sendMessage: (content) => pi.sendMessage({ customType: CHANGE_MESSAGE_TYPE, content, display: true }),
      };
      const progress = createAgentProgress({
        command: parseChangeCommand(args)?.action ?? "",
        ui: context.ui,
        sendMessage: typedContext.sendMessage!,
      });
      typedContext.onAgentStart = progress.observe;
      try {
        const invocationDependencies = await dependencies.forInvocation?.(typedContext) ?? dependencies;
        await dispatchChangeCommand(args, typedContext, invocationDependencies);
      } catch (error) {
        const parsed = parseChangeCommand(args);
        emitOutcome(typedContext, terminalErrorOutcome(error, parsed));
      } finally {
        progress.finish();
      }
    },
  });
}
