import type { ChangeAction } from "../controller/action-resolver.ts";
import { DEFAULT_SNAPSHOT_LANE, type ChangeSnapshot } from "../controller/change-snapshot.ts";
import type { DecisionSummary } from "../judgment/audit.ts";
import type { ChangeUsageSummary } from "../persistence/change-usage-store.ts";
import { HOST_EXECUTION_SECURITY_NOTICE } from "../tools/command-profile.ts";
import type { ChangeCommandContext } from "./context.ts";
import { renderCommandOutcome, type CommandBlocker, type CommandOutcome } from "./command.ts";

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

/** One line per judgment decision that has records; nothing at all when there are none. */
function renderJudgmentSummary(decisions: readonly DecisionSummary[]): string[] {
  if (decisions.length === 0) return [];
  return [
    "Judgment:",
    ...decisions.map((summary) => {
      const unavailable = Object.entries(summary.unavailable).map(([reason, count]) => `${reason} ${count}`);
      return [
        `  ${summary.decision} v${summary.decisionVersion}: ${summary.calls} calls`,
        `${summary.acted} acted`,
        `${summary.wouldHaveActed} would have acted`,
        ...(unavailable.length > 0 ? [`unavailable (${unavailable.join(", ")})`] : []),
        ...(summary.reconciled > 0 ? [`agreement ${summary.agreed} of ${summary.reconciled}`] : []),
      ].join(", ");
    }),
  ];
}

function renderLane({ lane, source, escalations }: NonNullable<ChangeSnapshot["lane"]>): string {
  return `Lane: ${lane} (${source}), ${escalations} escalation(s)`;
}

export function renderChangeStatus(
  snapshot: ChangeSnapshot,
  usage?: ChangeUsageSummary | null,
  decisions: readonly DecisionSummary[] = [],
): string {
  return [
    `Change: ${snapshot.changeName}`,
    `Lifecycle: ${snapshot.lifecycle}`,
    renderLane(snapshot.lane ?? DEFAULT_SNAPSHOT_LANE),
    `Review: ${snapshot.freshness.review}`,
    `Validation: ${snapshot.freshness.validation}`,
    `Pending checkpoints: ${snapshot.pendingCheckpointIds.length}`,
    ...(usage ? renderChangeUsage(usage) : []),
    ...renderJudgmentSummary(decisions),
    HOST_EXECUTION_SECURITY_NOTICE,
  ].join("\n");
}

/** Presents a lifecycle rejection; the decision itself belongs to the action resolver. */
export function lifecycleBlocker(
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

/** Posts an outcome to the transcript, falling back to a toast when no host renderer exists. */
export function emitOutcome(context: ChangeCommandContext, outcome: CommandOutcome): void {
  if (context.sendMessage) {
    context.sendMessage(outcome);
    return;
  }
  context.ui.notify(
    renderCommandOutcome(outcome),
    outcome.status === "failure" ? "error" : outcome.status === "success" ? "info" : "warning",
  );
}
