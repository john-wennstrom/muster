import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileTaskDag } from "../execution/delegation-dag.ts";
import { validateAgainstOwnReferences } from "../execution/load-tasks.ts";
import type { ValidatedTask, ValidatedTaskDocument } from "../execution/task-schema.ts";
import { parseVerificationCommand } from "../execution/verification-command.ts";
import { LANE_POLICY, type Lane } from "../controller/lane.ts";
import { deniedPaths } from "../judgment/egress.ts";
import type { OpenSpecAdapter } from "../openspec/adapter.ts";
import { readFileOrNull } from "../shared/fs.ts";
import { validateExecutable, type CommandProfile } from "../tools/command-profile.ts";

/** One requirement of a change's delta specifications, with the scenarios under it. */
export interface SpecRequirement {
  readonly capability: string;
  readonly name: string;
  readonly text: string;
  readonly scenarios: readonly { readonly name: string; readonly text: string }[];
}

export interface LintResult {
  /** Everything that blocks the command; empty when the plan may go on. */
  readonly errors: readonly string[];
  /** Small-lane limits the plan exceeds; each moves the change up a lane instead of failing. */
  readonly escalations: readonly string[];
  /** The checks that ran, for the record of a lint approval. */
  readonly checks: readonly string[];
  readonly document: ValidatedTaskDocument | null;
  readonly requirements: readonly SpecRequirement[];
}

const ARTIFACTS = ["proposal.md", "design.md", "tasks.md"] as const;
export const LINT_CHECKS = [
  "artifacts exist and parse",
  "openspec validate --strict",
  "task metadata is valid",
  "references resolve against the change's specifications",
  "every scenario is cited by a task",
  "verification commands are allowed by the profile",
  "write scopes avoid credential files and .git",
  "dependencies are acyclic",
] as const;

/** Requirements and their scenarios, read from a spec file's headings. */
export function parseSpecRequirements(capability: string, contents: string): SpecRequirement[] {
  const requirements: { name: string; lines: string[]; scenarios: { name: string; lines: string[] }[] }[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const requirement = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
    const scenario = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line);
    if (requirement) requirements.push({ name: requirement[1]!, lines: [], scenarios: [] });
    else if (scenario && requirements.length > 0) requirements.at(-1)!.scenarios.push({ name: scenario[1]!, lines: [] });
    else if (requirements.length > 0) {
      const current = requirements.at(-1)!;
      (current.scenarios.length > 0 ? current.scenarios.at(-1)!.lines : current.lines).push(line);
    }
  }
  return requirements.map((requirement) => ({
    capability,
    name: requirement.name,
    text: requirement.lines.join("\n").trim(),
    scenarios: requirement.scenarios.map(({ name, lines }) => ({ name, text: lines.join("\n").trim() })),
  }));
}

async function readSpecs(changeRoot: string): Promise<SpecRequirement[]> {
  const found: SpecRequirement[] = [];
  const directories = (await readdir(join(changeRoot, "specs")).catch(() => [] as string[])).sort();
  for (const capability of directories) {
    const contents = await readFileOrNull(resolve(changeRoot, "specs", capability, "spec.md"));
    if (contents !== null) found.push(...parseSpecRequirements(capability, contents));
  }
  return found;
}

const requirementKey = (capability: string, name: string) => `${capability}: ${name}`;
const touchesGit = (scope: string) => /^\.git(?:\/|$)/.test(scope.replaceAll("\\", "/").replace(/^\.\//, ""));

function checkTasks(tasks: readonly ValidatedTask[], specs: readonly SpecRequirement[], profile: CommandProfile, errors: string[]): void {
  const known = new Map(specs.map((requirement) => [requirementKey(requirement.capability, requirement.name), requirement]));
  const cited = new Set<string>();
  for (const task of tasks) {
    const scenariosUnderCited = new Set<string>();
    for (const reference of task.requirements) {
      const requirement = known.get(reference);
      if (!requirement) {
        errors.push(`task ${task.id}: requirement "${reference}" is not in any specification of this change`);
        continue;
      }
      for (const scenario of requirement.scenarios) scenariosUnderCited.add(scenario.name);
    }
    for (const scenario of task.scenarios) {
      if (scenariosUnderCited.has(scenario)) cited.add(scenario);
      else errors.push(`task ${task.id}: scenario "${scenario}" is not under a requirement the task cites`);
    }
    task.verify.forEach((command) => {
      try {
        validateExecutable(profile, parseVerificationCommand(command).executable);
      } catch (error) {
        errors.push(`task ${task.id}: verification command "${command}": ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    for (const scope of task.writes) {
      if (deniedPaths([scope]).length > 0) errors.push(`task ${task.id}: write scope "${scope}" names a credential file`);
      else if (touchesGit(scope)) errors.push(`task ${task.id}: write scope "${scope}" is inside .git`);
    }
  }
  for (const requirement of specs) {
    for (const scenario of requirement.scenarios) {
      if (!cited.has(scenario.name)) {
        errors.push(`scenario "${scenario.name}" of requirement "${requirementKey(requirement.capability, requirement.name)}" is cited by no task`);
      }
    }
  }
  try {
    compileTaskDag(tasks.map((task) => ({ id: task.id, dependsOn: task.dependsOn, checked: task.checked })), "0".repeat(64), new Date().toISOString());
  } catch (error) {
    const cycle = (error as { details?: { cycle?: string[] } }).details?.cycle;
    errors.push(cycle ? `tasks form a dependency cycle: ${cycle.join(" -> ")}` : `task dependencies are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reads the change's artifacts from disk and checks everything code can check, so that no
 * reviewer and no judgment request is spent on a plan with a structural mistake. Errors block;
 * escalations (small lane only) are limits the plan exceeds.
 */
export async function lintChange(input: {
  changeRoot: string;
  changeName: string;
  lane: Lane;
  profile: CommandProfile;
  openSpec: Pick<OpenSpecAdapter, "validate">;
}): Promise<LintResult> {
  const errors: string[] = [];
  const escalations: string[] = [];
  const contents = new Map<string, string | null>();
  for (const name of ARTIFACTS) contents.set(name, await readFileOrNull(resolve(input.changeRoot, name)));
  for (const [name, text] of contents) if (text === null) errors.push(`${name} is missing`);
  const specs = await readSpecs(input.changeRoot);
  if (specs.length === 0) errors.push("the change has no specification file with a requirement");

  try {
    const validation = await input.openSpec.validate(input.changeName);
    for (const item of validation.items.filter(({ valid }) => !valid)) {
      errors.push(`openspec validate --strict: ${item.id} is invalid (${item.issues.length} issue(s))`);
    }
  } catch (error) {
    errors.push(`openspec validate --strict could not run: ${error instanceof Error ? error.message : String(error)}`);
  }

  let document: ValidatedTaskDocument | null = null;
  const tasksText = contents.get("tasks.md");
  if (tasksText) {
    try {
      document = validateAgainstOwnReferences(tasksText, resolve(input.changeRoot, "tasks.md"));
    } catch (error) {
      errors.push(`tasks.md: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (document) {
    checkTasks(document.tasks, specs, input.profile, errors);
    const policy = LANE_POLICY[input.lane];
    if (input.lane === "small") {
      if (document.tasks.length > policy.maxTasks) {
        escalations.push(`the plan has ${document.tasks.length} tasks and the small lane allows ${policy.maxTasks}`);
      }
      const manual = document.tasks.filter((task) => task.role === "manual").map((task) => task.id);
      if (manual.length > 0 && !policy.allowManualTasks) {
        escalations.push(`the plan has manual task(s) ${manual.join(", ")}, which the small lane does not allow`);
      }
    }
  }
  return { errors, escalations, checks: LINT_CHECKS, document, requirements: specs };
}
