import { posix } from "node:path";
import { compileTaskDag } from "../execution/delegation-dag.ts";
import { parseVerificationCommand } from "../execution/verification-command.ts";
import { validateExecutable, type CommandProfile } from "../tools/command-profile.ts";
import { HarnessError } from "../shared/errors.ts";
import { CAPABILITY_NAME, type PlanError, type ProposalPlan } from "./plan-schema.ts";

export interface PlanValidationOptions {
  /** The profile every verification command's executable must pass. */
  readonly verificationProfile: CommandProfile;
}

const kindOf = (requirement: ProposalPlan["requirements"][number]) => requirement.kind ?? "ADDED";
const key = (capability: string, name: string) => `${capability}: ${name}`;

function scopeError(scope: string): string | null {
  const portable = scope.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable) || portable.includes("\0")) {
    return "must be repository-relative";
  }
  const normalized = posix.normalize(portable);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return "escapes the repository root";
  return null;
}

/**
 * Everything beyond the schema that must hold before anything is written. Returns every problem
 * found, each with the path of the field it is about, so one retry can fix all of them.
 */
export function validatePlan(plan: ProposalPlan, options: PlanValidationOptions): PlanError[] {
  const errors: PlanError[] = [];
  const add = (path: string, message: string) => errors.push({ path, message });

  for (const [list, names] of [["new", plan.capabilities.new], ["modified", plan.capabilities.modified]] as const) {
    names.forEach((name, index) => {
      if (!CAPABILITY_NAME.test(name)) add(`capabilities.${list}[${index}]`, "must be a kebab-case name");
    });
  }

  // Requirements: each name once per capability, scenarios for what needs them, and the fields each kind requires.
  const requirements = new Map<string, Set<string>>();
  const seenRequirements = new Set<string>();
  plan.requirements.forEach((requirement, index) => {
    const path = `requirements[${index}]`;
    const id = key(requirement.capability, requirement.name);
    if (seenRequirements.has(id)) add(path, `duplicates requirement "${id}"`);
    seenRequirements.add(id);
    const kind = kindOf(requirement);
    const scenarioNames = new Set<string>();
    (requirement.scenarios ?? []).forEach((scenario, position) => {
      if (scenarioNames.has(scenario.name)) add(`${path}.scenarios[${position}]`, `duplicates scenario "${scenario.name}"`);
      scenarioNames.add(scenario.name);
    });
    requirements.set(id, scenarioNames);
    if ((kind === "ADDED" || kind === "MODIFIED") && scenarioNames.size === 0) {
      add(`${path}.scenarios`, `requirement "${requirement.name}" has no scenario`);
    }
    if (kind === "REMOVED" && !requirement.migration) add(`${path}.migration`, "a removed requirement needs a migration");
    if (kind === "RENAMED" && !requirement.renamedFrom) add(`${path}.renamedFrom`, "a renamed requirement needs its previous name");
    const declared = plan.capabilities.new.includes(requirement.capability)
      || plan.capabilities.modified.includes(requirement.capability);
    if (!declared) add(`${path}.capability`, `capability "${requirement.capability}" is not listed under capabilities`);
  });

  // Tasks: identifiers, references, and every field the implement-time loader checks.
  const taskIds = new Set<string>();
  const groups = new Map<string, string>();
  plan.tasks.forEach((task, index) => {
    const path = `tasks[${index}]`;
    if (taskIds.has(task.id)) add(`${path}.id`, `duplicates task ${task.id}`);
    taskIds.add(task.id);
    const phase = task.id.split(".")[0]!;
    const group = groups.get(phase);
    if (group !== undefined && group !== task.group) {
      add(`${path}.group`, `tasks numbered ${phase}.* must share one group, but this one says "${task.group}" and another says "${group}"`);
    }
    groups.set(phase, group ?? task.group);
    if (task.role === "manual" && !task.manual) add(`${path}.manual`, "is required when role is manual");

    const cited = new Set<string>();
    task.requirements.forEach((reference, position) => {
      const id = key(reference.capability, reference.name);
      if (!requirements.has(id)) {
        add(`${path}.requirements[${position}]`, `references unknown requirement "${id}"`);
        return;
      }
      cited.add(id);
    });
    const citedScenarios = new Set([...cited].flatMap((id) => [...requirements.get(id)!]));
    task.scenarios.forEach((name, position) => {
      if (!citedScenarios.has(name)) {
        add(`${path}.scenarios[${position}]`, `scenario "${name}" is not under any requirement this task cites`);
      }
    });

    task.verify.forEach((command, position) => {
      try {
        const { executable } = parseVerificationCommand(command);
        validateExecutable(options.verificationProfile, executable);
      } catch (error) {
        const reason = error instanceof HarnessError || error instanceof Error ? error.message : String(error);
        add(`${path}.verify[${position}]`, reason);
      }
    });
    for (const [field, scopes] of [["reads", task.reads], ["writes", task.writes]] as const) {
      scopes.forEach((scope, position) => {
        const problem = scopeError(scope);
        if (problem) add(`${path}.${field}[${position}]`, `scope "${scope}" ${problem}`);
      });
    }
  });

  plan.tasks.forEach((task, index) => {
    task.dependsOn.forEach((dependency, position) => {
      if (!taskIds.has(dependency)) add(`tasks[${index}].dependsOn[${position}]`, `depends on unknown task ${dependency}`);
    });
  });

  // The dependency graph, checked the way the scheduler will compile it.
  if (!errors.some(({ path }) => path.endsWith("id") || path.includes("dependsOn"))) {
    try {
      compileTaskDag(
        plan.tasks.map((task) => ({ id: task.id, dependsOn: task.dependsOn, checked: false })),
        "0".repeat(64),
        new Date().toISOString(),
      );
    } catch (error) {
      const cycle = (error as HarnessError).details?.cycle as string[] | undefined;
      add("tasks", cycle ? `dependency cycle: ${cycle.join(" -> ")}` : error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}
