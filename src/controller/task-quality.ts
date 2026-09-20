import { createHash } from "node:crypto";
import { truncateBytes } from "../context/candidates.ts";
import { validateAgainstOwnReferences } from "../execution/load-tasks.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import {
  listDecisionRecords,
  reconcileDecisionRecord,
  type DecisionRecord,
} from "../judgment/audit.ts";
import {
  TASK_QUALITY_DIGEST_KEY,
  TASK_QUALITY_TASK_IDS_KEY,
  planningTaskQualityDecision,
  presentTaskQualityFindings,
  taskQualityOutcomeKey,
  taskQualityState,
  type TaskQualityFinding,
  type TaskQualityInput,
  type TaskQualityRequirementInput,
  type TaskQualityTaskInput,
} from "../judgment/gates.ts";
import { TASK_QUALITY_KINDS, canonicalize, type TaskQualityKind } from "../judgment/questions.ts";

/**
 * The plan-time task quality assessment's inputs and its bookkeeping: a pure builder that turns
 * a synthesis bundle into the judgment state, the digest that binds findings to task
 * definitions, and the helpers that find, show, and reconcile the resulting record. Nothing here
 * writes a planning artifact; findings are advice and only ever travel as fixed-template text.
 */

/** More tasks than this are not assessed: the question count and the state would outgrow the service. */
export const TASK_QUALITY_MAX_TASKS = 40;
export const TASK_QUALITY_SUMMARY_BYTES = 2_000;
/** The state's target size, under the service's limit so questions and escaping fit beside it. */
const STATE_TARGET_BYTES = 80_000;
const MAX_TEXT_EXCERPT_BYTES = 800;

export interface TaskQualityBundleArtifact {
  readonly path: string;
  readonly content: string;
}

export type TaskQualitySkipReason = "no_tasks" | "too_many_tasks" | "invalid_tasks";

export type TaskQualityAssessmentInput =
  | {
      readonly ok: true;
      readonly input: TaskQualityInput;
      /** In state order, so a finding's one-based index names `taskIds[index - 1]`. */
      readonly taskIds: readonly string[];
      readonly digest: string;
    }
  | { readonly ok: false; readonly reason: TaskQualitySkipReason };

const compareIds = (left: string, right: string): number =>
  left.localeCompare(right, "en", { numeric: true });

/** Identifies a task list by what its tasks say to do, never by which are ticked off. */
export function taskDefinitionDigest(tasks: readonly TaskQualityTaskInput[]): string {
  const definitions = [...tasks]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((task) => ({
      id: task.id,
      description: task.description,
      dependsOn: [...task.dependsOn],
      reads: [...task.reads],
      writes: [...task.writes],
      verify: [...task.verify],
    }));
  return `sha256:${createHash("sha256").update(canonicalize(definitions)).digest("hex")}`;
}

interface DraftScenario {
  name: string;
  lines: string[];
}

interface DraftRequirement {
  name: string;
  lines: string[];
  scenarios: DraftScenario[];
}

/** Requirement and scenario names with their body text, read from delta-spec headings. */
function draftRequirements(specs: readonly string[]): DraftRequirement[] {
  const requirements: DraftRequirement[] = [];
  for (const spec of specs) {
    let requirement: DraftRequirement | null = null;
    let target: string[] | null = null;
    for (const line of spec.split(/\r?\n/)) {
      const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
      if (!heading) {
        target?.push(line);
        continue;
      }
      const requirementName = /^Requirement:\s*(.+)$/.exec(heading[1]!)?.[1];
      const scenarioName = /^Scenario:\s*(.+)$/.exec(heading[1]!)?.[1];
      if (requirementName) {
        requirement = { name: requirementName, lines: [], scenarios: [] };
        requirements.push(requirement);
        target = requirement.lines;
      } else if (scenarioName && requirement) {
        const scenario: DraftScenario = { name: scenarioName, lines: [] };
        requirement.scenarios.push(scenario);
        target = scenario.lines;
      } else {
        target = null;
      }
    }
  }
  return requirements;
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * Turns a synthesis bundle into the assessment input. Any rejection by the task parser or
 * validator, an empty list, or a list over the cap skips the assessment: reporting a malformed
 * task list belongs to the review and the snapshot, and planning proceeds as it does without
 * judgment. Requirement and scenario names are always kept; only their text is excerpted, to
 * what the state's size target leaves after the names, tasks, and summary.
 */
export function buildTaskQualityInput(artifacts: readonly TaskQualityBundleArtifact[]): TaskQualityAssessmentInput {
  const normalized = artifacts.map(({ path, content }) => ({ path: path.replaceAll("\\", "/"), content }));
  const tasksContent = normalized.find(({ path }) => path === "tasks.md")?.content;
  if (tasksContent === undefined) return { ok: false, reason: "invalid_tasks" };

  let tasks: TaskQualityTaskInput[];
  try {
    tasks = validateAgainstOwnReferences(tasksContent, "tasks.md").tasks.map((task) => ({
      id: task.id,
      description: task.description,
      dependsOn: task.dependsOn,
      reads: task.reads,
      writes: task.writes,
      verify: task.verify,
    }));
  } catch {
    return { ok: false, reason: "invalid_tasks" };
  }
  if (tasks.length === 0) return { ok: false, reason: "no_tasks" };
  if (tasks.length > TASK_QUALITY_MAX_TASKS) return { ok: false, reason: "too_many_tasks" };

  const summary = truncateBytes(
    normalized.find(({ path }) => path === "proposal.md")?.content.trim() ?? "",
    TASK_QUALITY_SUMMARY_BYTES,
  );
  const drafts = draftRequirements(
    normalized.filter(({ path }) => /^specs\/.+\/spec\.md$/.test(path)).map(({ content }) => content),
  );
  const withText = (excerpt: (text: string) => string): TaskQualityRequirementInput[] =>
    drafts.map((draft) => ({
      name: draft.name,
      text: excerpt(draft.lines.join("\n").trim()),
      scenarios: draft.scenarios.map((scenario) => ({
        name: scenario.name,
        text: excerpt(scenario.lines.join("\n").trim()),
      })),
    }));

  const namesOnly = { summary, requirements: withText(() => ""), tasks };
  const itemCount = drafts.reduce((sum, draft) => sum + 1 + draft.scenarios.length, 0);
  const remaining = STATE_TARGET_BYTES - bytes(JSON.stringify(taskQualityState(namesOnly)));
  const perItem = itemCount === 0 || remaining <= 0
    ? 0
    : Math.min(MAX_TEXT_EXCERPT_BYTES, Math.floor(remaining / itemCount));
  const excerpt = (text: string): string => {
    if (perItem === 0) return "";
    const kept = truncateBytes(text, perItem);
    return kept.length < text.length ? `${kept}…` : kept;
  };

  return {
    ok: true,
    input: { summary, requirements: withText(excerpt), tasks },
    taskIds: tasks.map((task) => task.id),
    digest: taskDefinitionDigest(tasks),
  };
}

/** Binds a recorded assessment to the task definitions it was made for, and to their order. */
export async function bindTaskQualityRecord(
  store: AtomicJsonStore,
  changeName: string,
  recordId: string,
  binding: { readonly digest: string; readonly taskIds: readonly string[] },
): Promise<void> {
  await reconcileDecisionRecord(store, changeName, recordId, {
    observed: { [TASK_QUALITY_DIGEST_KEY]: binding.digest, [TASK_QUALITY_TASK_IDS_KEY]: [...binding.taskIds] },
  });
}

const isKind = (value: unknown): value is TaskQualityKind =>
  typeof value === "string" && (TASK_QUALITY_KINDS as readonly string[]).includes(value);

/** The findings a record's gate produced, checked for shape because the record stores plain JSON. */
export function recordedTaskQualityFindings(record: DecisionRecord): TaskQualityFinding[] {
  if (!record.gate?.act) return [];
  const findings = (record.gate.value as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings)) return [];
  const valid: TaskQualityFinding[] = [];
  for (const item of findings) {
    const { kind, index, probability, score } = (item ?? {}) as Record<string, unknown>;
    if (!isKind(kind) || typeof probability !== "number" || !Number.isFinite(probability)) continue;
    if (index !== null && !(typeof index === "number" && Number.isInteger(index) && index >= 1)) continue;
    valid.push({
      kind,
      index: index as number | null,
      probability,
      ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
    });
  }
  return valid;
}

function recordedTaskIds(record: DecisionRecord): readonly string[] {
  const ids = record.observed[TASK_QUALITY_TASK_IDS_KEY];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The latest answered assessment for exactly these task definitions. With `enforcedOnly`, a
 * record counts only if its gate acted in enforce mode, so shadow findings are never surfaced.
 */
export async function findTaskQualityRecord(
  store: AtomicJsonStore,
  changeName: string,
  digest: string,
  options: { readonly enforcedOnly?: boolean } = {},
): Promise<DecisionRecord | null> {
  const matching = (await listDecisionRecords(store, changeName)).filter((record) =>
    record.decision === planningTaskQualityDecision.id
    && record.status === "answered"
    && record.observed[TASK_QUALITY_DIGEST_KEY] === digest
    && (!options.enforcedOnly || record.acted));
  return matching.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1) ?? null;
}

/**
 * The rendered findings still current for a tasks.md, for a reviewer's prompt. Empty when the
 * task list does not parse, when no enforced assessment matches its current definitions, or when
 * anything at all goes wrong: notes are advice and never a reason to fail a review.
 */
export async function currentTaskQualityNotes(input: {
  readonly store: AtomicJsonStore;
  readonly changeName: string;
  readonly tasksContents: string;
}): Promise<readonly string[]> {
  try {
    const tasks = validateAgainstOwnReferences(input.tasksContents, "tasks.md").tasks;
    const record = await findTaskQualityRecord(
      input.store,
      input.changeName,
      taskDefinitionDigest(tasks),
      { enforcedOnly: true },
    );
    if (!record) return [];
    return presentTaskQualityFindings(recordedTaskQualityFindings(record), recordedTaskIds(record)).lines;
  } catch {
    return [];
  }
}

let reconciliation: Promise<unknown> = Promise.resolve();

/**
 * Records a task's first-attempt outcome, and whether the plan-time assessment flagged it, on
 * the assessment record for the current task definitions. A later attempt never overwrites the
 * first, and a missing record is harmless. Writes are serialized because tasks can finish
 * together and each write replaces the whole record.
 */
export function reconcileTaskQualityOutcome(input: {
  readonly store: AtomicJsonStore;
  readonly changeName: string;
  readonly tasks: readonly TaskQualityTaskInput[];
  readonly taskId: string;
  readonly status: string;
}): Promise<void> {
  const work = async (): Promise<void> => {
    try {
      const record = await findTaskQualityRecord(input.store, input.changeName, taskDefinitionDigest(input.tasks));
      if (!record) return;
      const key = taskQualityOutcomeKey(input.taskId);
      if (record.observed[key] !== undefined) return;
      const position = recordedTaskIds(record).indexOf(input.taskId) + 1;
      if (position === 0) return;
      const flagged = [...new Set(recordedTaskQualityFindings(record)
        .filter((finding) => finding.index === position || finding.index === null)
        .map((finding) => finding.kind))];
      await reconcileDecisionRecord(input.store, input.changeName, record.recordId, {
        observed: { [key]: { status: input.status, flagged } },
      });
    } catch {
      // Reconciliation is measurement; a failure to write it must not fail implementation.
    }
  };
  const next = reconciliation.then(work, work);
  reconciliation = next;
  return next;
}
