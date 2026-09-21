import { invalidDecision, validateDecision, type AnyDecision } from "./decision.ts";
import { changeTriageDecision } from "./decisions/change-triage.ts";
import { reviewTaskFocusDecision } from "./decisions/review-task-focus.ts";
import { commandClassificationDecision } from "./decisions/command-classification.ts";
import { reviewExtractionDecision } from "./decisions/review-extraction.ts";
import { planLintDecision } from "./decisions/plan-lint.ts";
import { taskRecoveryDecision } from "./decisions/task-recovery.ts";
import { reviewTriageDecision } from "./decisions/review-triage.ts";
import { modelRoutingDecision } from "./decisions/routing-task-model.ts";

export function validateCatalog(decisions: readonly AnyDecision[]): void {
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.id)) invalidDecision(decision.id, "duplicates a decision identifier");
    seen.add(decision.id);
    validateDecision(decision);
  }
}

/**
 * Every decision the harness can ask. Later changes append here; none modifies another's.
 */
export const judgmentCatalog: readonly AnyDecision[] = [
  changeTriageDecision,
  reviewTaskFocusDecision,
  commandClassificationDecision,
  reviewExtractionDecision,
  planLintDecision,
  taskRecoveryDecision,
  reviewTriageDecision,
  modelRoutingDecision,
];
