import { renderChangeStatus } from "../outcome.ts";
import type { ChangeStateQuery, CommandOutcome } from "../command.ts";
import type { ChangeSnapshot } from "../../controller/change-snapshot.ts";
import type { ChangeUsageSummary } from "../../persistence/change-usage-store.ts";
import type { DecisionSummary } from "../../judgment/audit.ts";
import { loadProductionChangeUsage, loadProductionDecisionSummaries } from "../snapshot.ts";

export interface ProductionStatusOptions extends ChangeStateQuery {
  /** The already-loaded snapshot; status never reloads what the invocation resolved. */
  snapshot: ChangeSnapshot | null;
  loadUsage?(query: ChangeStateQuery): Promise<ChangeUsageSummary | null>;
  loadDecisions?(query: ChangeStateQuery): Promise<readonly DecisionSummary[]>;
}

export async function runProductionStatus(
  options: ProductionStatusOptions,
): Promise<CommandOutcome> {
  if (!options.snapshot) {
    return {
      status: "blocked",
      action: "status",
      changeName: options.changeName,
      summary: `Change ${options.changeName} does not have a readable production snapshot.`,
    };
  }
  const query = {
    cwd: options.cwd,
    changeName: options.changeName,
    signal: options.signal,
    now: options.now,
  };
  const usage = await (options.loadUsage ?? loadProductionChangeUsage)(query);
  const decisions = await (options.loadDecisions ?? loadProductionDecisionSummaries)(query);
  return {
    status: "success",
    action: "status",
    changeName: options.changeName,
    summary: renderChangeStatus(options.snapshot, usage, decisions),
  };
}
