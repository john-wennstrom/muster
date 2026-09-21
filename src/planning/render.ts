import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPromptRenderer, PROMPTS_ROOT } from "../prompts/render.ts";
import { isWithin } from "../shared/paths.ts";
import { HarnessError } from "../shared/errors.ts";
import { CAPABILITY_NAME, type PlanRequirement, type ProposalPlan } from "./plan-schema.ts";

const templates = createPromptRenderer(resolve(PROMPTS_ROOT, "artifacts"));
const render = (name: string, variables: Record<string, string> = {}): string => String(templates.render(name, variables));

export interface RenderedArtifact {
  /** Absolute, under the change root. */
  readonly path: string;
  readonly content: string;
}

const bullets = (items: readonly string[]): string => items.map((item) => `- ${item}`).join("\n");
const listOrNone = (items: readonly string[]): string => (items.length > 0 ? bullets(items) : render("empty-list"));
const blocks = (items: readonly string[]): string => items.join("\n\n");
const kindOf = (requirement: PlanRequirement) => requirement.kind ?? "ADDED";

function renderProposal(plan: ProposalPlan): string {
  const requirementNames = (capability: string) =>
    plan.requirements.filter((requirement) => requirement.capability === capability).map(({ name }) => name).join("; ");
  const capabilityLines = (names: readonly string[]) =>
    listOrNone(names.map((name) => `\`${name}\`: ${requirementNames(name)}`));
  return render("proposal", {
    WHY: plan.why,
    CHANGES: bullets(plan.changes),
    NEW_CAPABILITIES: capabilityLines(plan.capabilities.new),
    MODIFIED_CAPABILITIES: capabilityLines(plan.capabilities.modified),
    IMPACT: listOrNone(plan.impact),
  });
}

function renderDesign(plan: ProposalPlan): string {
  const design = plan.design;
  if (!design) return render("design-none");
  return render("design", {
    CONTEXT: design.context,
    GOALS: listOrNone(design.goals),
    NON_GOALS: listOrNone(design.nonGoals),
    DECISIONS: design.decisions.length > 0
      ? blocks(design.decisions.map(({ title, body }) => render("design-decision", { TITLE: title, BODY: body })))
      : render("empty-list"),
    RISKS: listOrNone(design.risks),
    MIGRATION_BLOCK: design.migration ? render("design-migration", { MIGRATION: design.migration }) : "",
  });
}

function renderRequirement(requirement: PlanRequirement): string {
  const kind = kindOf(requirement);
  if (kind === "REMOVED") {
    return render("requirement-removed", { NAME: requirement.name, REASON: requirement.text, MIGRATION: requirement.migration ?? "" });
  }
  if (kind === "RENAMED") {
    return render("requirement-renamed", { FROM: requirement.renamedFrom ?? "", TO: requirement.name });
  }
  return render("requirement", {
    NAME: requirement.name,
    TEXT: requirement.text,
    SCENARIOS: blocks((requirement.scenarios ?? []).map((scenario) =>
      render("scenario", { NAME: scenario.name, WHEN: scenario.when, THEN: scenario.then }))),
  });
}

/** One delta spec: a section per kind of change, in the order OpenSpec reads them. */
function renderSpec(requirements: readonly PlanRequirement[]): string {
  const section = (kind: (typeof kinds)[number]) => {
    const inKind = requirements.filter((requirement) => kindOf(requirement) === kind);
    if (inKind.length === 0) return "";
    const body = kind === "RENAMED" ? inKind.map(renderRequirement).join("\n") : blocks(inKind.map(renderRequirement));
    return render("spec-section", { KIND: kind, BODY: body });
  };
  const kinds = ["ADDED", "MODIFIED", "REMOVED", "RENAMED"] as const;
  return render("spec", {
    ADDED_SECTION: section("ADDED"),
    MODIFIED_SECTION: section("MODIFIED"),
    REMOVED_SECTION: section("REMOVED"),
    RENAMED_SECTION: section("RENAMED"),
  });
}

function renderTasks(plan: ProposalPlan): string {
  const byPhase = new Map<string, ProposalPlan["tasks"]>();
  for (const task of plan.tasks) {
    const phase = task.id.split(".")[0]!;
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), task]);
  }
  const json = (value: unknown) => JSON.stringify(value);
  const groups = [...byPhase.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([number, tasks]) => render("task-group", {
      NUMBER: number,
      TITLE: tasks[0]!.group,
      TASKS: blocks(tasks.map((task) => render("task", {
        ID: task.id,
        DESCRIPTION: task.description,
        ID_JSON: json(task.id),
        DEPENDS_ON: json(task.dependsOn),
        ROLE: task.role ?? "builder",
        READS: json(task.reads),
        WRITES: json(task.writes),
        REQUIREMENTS: json(task.requirements.map(({ capability, name }) => `${capability}: ${name}`)),
        SCENARIOS: json(task.scenarios),
        VERIFY: json(task.verify),
        MANUAL: json(task.manual ?? null),
      }))),
    }));
  return render("tasks", { TASK_GROUPS: blocks(groups) });
}

/**
 * Every OpenSpec artifact of a plan, at fixed paths under the change root. Nothing the session
 * wrote chooses a path: file names come from the four fixed artifact names and from capability
 * names that are checked against a kebab-case pattern here as well as in validation.
 */
export function renderArtifacts(plan: ProposalPlan, changeRoot: string): RenderedArtifact[] {
  const root = resolve(changeRoot);
  const at = (relative: string): string => {
    const path = resolve(root, relative);
    if (!isWithin(root, path)) {
      throw new HarnessError("PLANNING_ARTIFACT_INVALID", "A rendered artifact would leave the change root", { relative });
    }
    return path;
  };
  const capabilities = [...new Set(plan.requirements.map(({ capability }) => capability))];
  for (const capability of capabilities) {
    if (!CAPABILITY_NAME.test(capability)) {
      throw new HarnessError("PLANNING_ARTIFACT_INVALID", `Capability name is not a valid slug: ${capability}`, { capability });
    }
  }
  return [
    { path: at("proposal.md"), content: renderProposal(plan) },
    ...capabilities.map((capability) => ({
      path: at(`specs/${capability}/spec.md`),
      content: renderSpec(plan.requirements.filter((requirement) => requirement.capability === capability)),
    })),
    { path: at("design.md"), content: renderDesign(plan) },
    { path: at("tasks.md"), content: renderTasks(plan) },
  ];
}

/** Writes rendered artifacts, creating directories, each ending in a newline. */
export async function writeArtifacts(artifacts: readonly RenderedArtifact[]): Promise<void> {
  for (const artifact of artifacts) {
    await mkdir(dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, artifact.content.endsWith("\n") ? artifact.content : `${artifact.content}\n`, "utf8");
  }
}
