import type { ChangeLifecycle, ChangeSnapshot } from "./change-snapshot.ts";

export type ChangeAction =
  | "explore"
  | "propose"
  | "refine"
  | "review"
  | "implement"
  | "verify"
  | "finish"
  | "status"
  | "resume";

export interface ActionResolution {
  allowed: boolean;
  nextAction?: ChangeAction;
  reason?: string;
}

const allowedLifecycles: Partial<Record<ChangeAction, readonly ChangeLifecycle[]>> = {
  refine: ["PLANNING", "REVIEW_REQUIRED", "DESIGN_CONFLICT", "BLOCKED"],
  review: ["REVIEW_REQUIRED"],
  implement: ["READY", "IMPLEMENTING"],
  verify: ["VERIFYING"],
  finish: ["VERIFIED"],
  resume: ["AWAITING_USER"],
};

function nextAction(lifecycle: ChangeLifecycle): ChangeAction {
  if (lifecycle === "PLANNING" || lifecycle === "DESIGN_CONFLICT") return "refine";
  if (lifecycle === "REVIEW_REQUIRED") return "review";
  if (lifecycle === "READY" || lifecycle === "IMPLEMENTING") return "implement";
  if (lifecycle === "AWAITING_USER") return "resume";
  if (lifecycle === "VERIFYING") return "verify";
  if (lifecycle === "VERIFIED") return "finish";
  return "status";
}

export function resolveChangeAction(
  action: ChangeAction,
  snapshot: Pick<ChangeSnapshot, "lifecycle"> | null,
): ActionResolution {
  if (action === "explore" || action === "propose" || action === "status") {
    return { allowed: true };
  }
  if (!snapshot) {
    return { allowed: false, nextAction: "propose", reason: "No active change was resolved" };
  }
  if (allowedLifecycles[action]?.includes(snapshot.lifecycle)) return { allowed: true };
  const next = nextAction(snapshot.lifecycle);
  return {
    allowed: false,
    nextAction: next,
    reason: `Change lifecycle ${snapshot.lifecycle} does not allow ${action}`,
  };
}