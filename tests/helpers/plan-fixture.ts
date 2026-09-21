import { resolve } from "node:path";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { ProposalPlan } from "../../src/planning/plan-schema.ts";
import { renderArtifacts, writeArtifacts } from "../../src/planning/render.ts";
import { samplePlan } from "../planning/sample-plan.ts";

/** Writes a plan that lints cleanly into a change directory, for tests that run the review phase. */
export async function writeValidPlan(changeRoot: string, plan: ProposalPlan = samplePlan()): Promise<void> {
  await writeArtifacts(renderArtifacts(plan, resolve(changeRoot)));
}

/** An OpenSpec adapter stand-in whose status names the change root and whose strict validation passes. */
export function openSpecFor(changeRoot: string, changeName = "add-search"): OpenSpecAdapter {
  return {
    status: async () => ({ changeName, changeRoot }),
    validate: async () => ({ items: [{ id: changeName, type: "change", valid: true, issues: [] }] }),
  } as unknown as OpenSpecAdapter;
}
