import { z } from "zod";
import { createFreshRoleSession } from "../agents/role-runner.ts";
import type { DependencyReport } from "../agents/reports.ts";
import type { GitStatusEntry, GitWorktree } from "../execution/git.ts";
import type {
  CheckpointRecord,
  ReviewRecord,
  RunManifest,
  TaskResultRecord,
} from "../persistence/records.ts";
import type {
  OpenSpecApplyInstructions,
  OpenSpecStatus,
  OpenSpecValidation,
} from "../openspec/protocol.ts";

const nonEmptyString = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const finalValidationGateSchema = z.enum([
  "openspec",
  "tasks",
  "evidence",
  "tests",
  "findings",
  "design",
  "freshness",
  "reports",
  "repository",
]);

const finalValidationCheckSchema = z.object({
  gate: finalValidationGateSchema,
  status: z.enum(["PASS", "FAIL"]),
  summary: nonEmptyString,
  evidence: z.array(nonEmptyString),
}).strict();

export const finalValidationResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: nonEmptyString,
  changeName: nonEmptyString,
  sessionId: nonEmptyString,
  validatedAt: z.string().datetime({ offset: true }),
  access: z.literal("read"),
  result: z.enum(["PASS", "FAIL"]),
  readiness: z.enum(["READY_TO_FINISH", "BLOCKED"]),
  artifactDigest: digest.nullable(),
  sourceDigest: digest.nullable(),
  checks: z.array(finalValidationCheckSchema).length(finalValidationGateSchema.options.length),
  blockingReasons: z.array(nonEmptyString),
}).strict().superRefine((result, context) => {
  const expectedGates = new Set(finalValidationGateSchema.options);
  for (const check of result.checks) expectedGates.delete(check.gate);
  const hasDuplicateGate = new Set(result.checks.map((check) => check.gate)).size !== result.checks.length;
  if (expectedGates.size > 0 || hasDuplicateGate) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "Final validation must contain each gate exactly once",
    });
  }
  const failed = result.checks.filter((check) => check.status === "FAIL");
  const expectedResult = failed.length === 0 ? "PASS" : "FAIL";
  const expectedReadiness = failed.length === 0 ? "READY_TO_FINISH" : "BLOCKED";
  if (result.result !== expectedResult) {
    context.addIssue({ code: "custom", path: ["result"], message: `Expected ${expectedResult}` });
  }
  if (result.readiness !== expectedReadiness) {
    context.addIssue({ code: "custom", path: ["readiness"], message: `Expected ${expectedReadiness}` });
  }
  if ((failed.length === 0) !== (result.blockingReasons.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["blockingReasons"],
      message: "Blocking reasons must correspond to failed gates",
    });
  }
});

export type FinalValidationGate = z.infer<typeof finalValidationGateSchema>;
export type FinalValidationResult = z.infer<typeof finalValidationResultSchema>;

export interface FinalValidationContext {
  runId: string;
  changeName: string;
  sessionId: string;
  sessionDir: string;
  access: "read";
}

export interface FinalValidationTask {
  id: string;
  done: boolean;
  requirements: readonly string[];
  scenarios: readonly string[];
  verify: readonly string[];
  /** A planned manual step: a person does it, so a confirmed checkpoint stands in for a builder and a review. */
  manual?: boolean;
}

export interface CommandEvidence {
  command: string;
  exitCode: number;
}

export interface OpenSpecValidationInput {
  status: OpenSpecStatus;
  apply: OpenSpecApplyInstructions;
  validation: OpenSpecValidation;
  artifactDigest: string;
}

export interface PersistedEvidenceInput {
  manifest: RunManifest;
  taskResults: readonly TaskResultRecord[];
  reviews: readonly ReviewRecord[];
  checkpoints?: readonly CheckpointRecord[];
}

export interface TestValidationInput {
  focused: readonly CommandEvidence[];
  fullSuite: CommandEvidence | null;
}

export interface FindingValidationInput {
  unresolved: readonly {
    severity: "blocking" | "warning";
    source: string;
    message: string;
  }[];
}

export interface DesignValidationInput {
  available: boolean;
  aligned: boolean;
  evidence: readonly string[];
}

export interface FreshnessValidationInput {
  artifactDigest: string;
  sourceDigest: string;
  planningReviewDigest: string | null;
  staleInputs: readonly string[];
}

export interface ReportValidationInput {
  reports: readonly DependencyReport[];
}

export interface RepositoryValidationInput {
  repositoryId: string;
  commonDirectory: string;
  worktreePath: string;
  head: string;
  status: readonly GitStatusEntry[];
  worktrees: readonly GitWorktree[];
  sourceDigest: string;
  writerActive: boolean;
  pendingCheckpointIds: readonly string[];
  discrepancies: readonly string[];
}

export interface FinalValidatorDependencies {
  readOpenSpec(context: FinalValidationContext): Promise<OpenSpecValidationInput>;
  readTasks(context: FinalValidationContext): Promise<readonly FinalValidationTask[]>;
  readEvidence(context: FinalValidationContext): Promise<PersistedEvidenceInput>;
  runTests(context: FinalValidationContext): Promise<TestValidationInput>;
  readFindings(context: FinalValidationContext): Promise<FindingValidationInput>;
  checkDesign(context: FinalValidationContext): Promise<DesignValidationInput>;
  readFreshness(context: FinalValidationContext): Promise<FreshnessValidationInput>;
  readReports(context: FinalValidationContext): Promise<ReportValidationInput>;
  readRepository(context: FinalValidationContext): Promise<RepositoryValidationInput>;
  now?(): string;
}

export interface RunFinalValidationOptions {
  runId: string;
  changeName: string;
  sessionsRoot: string;
  dependencies: FinalValidatorDependencies;
  builderClaims?: readonly string[];
}

interface CollectedInputs {
  openspec: OpenSpecValidationInput;
  tasks: readonly FinalValidationTask[];
  evidence: PersistedEvidenceInput;
  tests: TestValidationInput;
  findings: FindingValidationInput;
  design: DesignValidationInput;
  freshness: FreshnessValidationInput;
  reports: ReportValidationInput;
  repository: RepositoryValidationInput;
}

type ValidationCheck = z.infer<typeof finalValidationCheckSchema>;

function check(
  gate: FinalValidationGate,
  reasons: readonly string[],
  evidence: readonly string[],
): ValidationCheck {
  return {
    gate,
    status: reasons.length === 0 ? "PASS" : "FAIL",
    summary: reasons.length === 0 ? `${gate} checks passed` : reasons.join("; "),
    evidence: [...evidence],
  };
}

function evaluateOpenSpec(input: CollectedInputs): ValidationCheck {
  const reasons: string[] = [];
  const { status, apply, validation } = input.openspec;
  if (status.changeName !== apply.changeName) reasons.push("OpenSpec status and tasks describe different changes");
  if (!status.isPlanningComplete || !status.isComplete) reasons.push("OpenSpec planning artifacts are incomplete");
  if (status.artifacts.some((artifact) => artifact.status !== "done")) reasons.push("OpenSpec has incomplete artifacts");
  if (validation.summary.totals.failed > 0 || validation.items.some((item) => !item.valid)) {
    reasons.push("OpenSpec strict validation failed");
  }
  return check("openspec", reasons, [
    `schema=${status.schemaName}`,
    `validated=${validation.summary.totals.passed}/${validation.summary.totals.items}`,
  ]);
}

function evaluateTasks(input: CollectedInputs): ValidationCheck {
  const reasons: string[] = [];
  const applyByDescription = new Map(input.openspec.apply.tasks.map((task) => [task.description, task]));
  if (input.tasks.length === 0) reasons.push("No executable tasks were found");
  for (const task of input.tasks) {
    if (!task.done) reasons.push(`Task ${task.id} is incomplete`);
    if (task.requirements.length === 0 || task.scenarios.length === 0) {
      reasons.push(`Task ${task.id} lacks requirement or scenario links`);
    }
    if (task.verify.length === 0) reasons.push(`Task ${task.id} has no focused verification command`);
  }
  if (input.openspec.apply.progress.remaining !== 0 || input.openspec.apply.tasks.some((task) => !task.done)) {
    reasons.push("OpenSpec apply state has incomplete tasks");
  }
  if (input.openspec.apply.tasks.length !== input.tasks.length || applyByDescription.size !== input.tasks.length) {
    reasons.push("Parsed tasks do not match current OpenSpec apply tasks");
  }
  return check("tasks", reasons, [`tasks=${input.tasks.length}`]);
}

function latestTaskResult(input: CollectedInputs, taskId: string): TaskResultRecord | undefined {
  return input.evidence.taskResults
    .filter((result) => result.runId === input.evidence.manifest.runId && result.taskId === taskId)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
}

function evaluateEvidence(input: CollectedInputs): ValidationCheck {
  const reasons: string[] = [];
  const { manifest, reviews } = input.evidence;
  if (manifest.runId.trim().length === 0) reasons.push("Persisted run manifest is missing");
  for (const task of input.tasks) {
    const result = latestTaskResult(input, task.id);
    if (!result || result.outcome !== "completed" || result.verificationEvidence.length === 0) {
      reasons.push(`Task ${task.id} lacks completed persisted evidence`);
      continue;
    }
    if (task.manual) {
      const confirmed = (input.evidence.checkpoints ?? []).some((checkpoint) =>
        checkpoint.runId === manifest.runId &&
        checkpoint.taskId === task.id &&
        checkpoint.status === "confirmed"
      );
      if (!confirmed) reasons.push(`Manual task ${task.id} has no confirmed checkpoint`);
      continue;
    }
    const approved = reviews.some((review) =>
      review.kind === "task" &&
      review.runId === manifest.runId &&
      review.taskId === task.id &&
      review.verdict === "APPROVE" &&
      review.artifactDigest === result.sourceDigest
    );
    if (!approved) reasons.push(`Task ${task.id} lacks a matching approved review`);
  }
  return check("evidence", reasons, [
    `task-results=${input.evidence.taskResults.length}`,
    `reviews=${reviews.length}`,
  ]);
}

function evaluateTests(input: CollectedInputs): ValidationCheck {
  const reasons: string[] = [];
  const focused = new Map(input.tests.focused.map((result) => [result.command, result]));
  for (const task of input.tasks) {
    for (const command of task.verify) {
      const result = focused.get(command);
      if (!result) reasons.push(`Missing focused test result: ${command}`);
      else if (result.exitCode !== 0) reasons.push(`Focused test failed: ${command}`);
    }
  }
  if (!input.tests.fullSuite) reasons.push("Required full test suite result is missing");
  else if (input.tests.fullSuite.exitCode !== 0) {
    reasons.push(`Required full test suite failed: ${input.tests.fullSuite.command}`);
  }
  return check("tests", reasons, [
    ...input.tests.focused.map((result) => `${result.command}: exit ${result.exitCode}`),
    ...(input.tests.fullSuite
      ? [`${input.tests.fullSuite.command}: exit ${input.tests.fullSuite.exitCode}`]
      : []),
  ]);
}

function evaluateFindings(input: CollectedInputs): ValidationCheck {
  const blocking = input.findings.unresolved.filter((finding) => finding.severity === "blocking");
  return check(
    "findings",
    blocking.map((finding) => `${finding.source}: ${finding.message}`),
    input.findings.unresolved.map((finding) => `${finding.severity}:${finding.source}`),
  );
}

function evaluateDesign(input: CollectedInputs): ValidationCheck {
  const reasons: string[] = [];
  if (!input.design.available) reasons.push("Required design input is missing");
  if (!input.design.aligned) reasons.push("Implementation is not aligned with the current design");
  if (input.design.evidence.length === 0) reasons.push("Design alignment has no evidence");
  return check("design", reasons, input.design.evidence);
}

function evaluateFreshness(input: CollectedInputs): ValidationCheck {
  const reasons = [...input.freshness.staleInputs];
  if (input.freshness.artifactDigest !== input.openspec.artifactDigest) {
    reasons.push("OpenSpec artifact observation is stale");
  }
  if (input.freshness.planningReviewDigest !== input.freshness.artifactDigest) {
    reasons.push("Planning review is missing or stale");
  }
  if (input.freshness.sourceDigest !== input.repository.sourceDigest) {
    reasons.push("Repository source observation is stale");
  }
  return check("freshness", reasons, [
    `artifact=${input.freshness.artifactDigest}`,
    `source=${input.freshness.sourceDigest}`,
  ]);
}

function evaluateReports(input: CollectedInputs): ValidationCheck {
  const reasons: string[] = [];
  const reports = new Map(input.reports.reports.map((report) => [report.taskId, report]));
  for (const task of input.tasks) {
    const report = reports.get(task.id);
    if (!report) reasons.push(`Task ${task.id} has no dependency report`);
    else if (report.runId !== input.evidence.manifest.runId || report.outcome !== "completed") {
      reasons.push(`Task ${task.id} has an unresolved dependency report`);
    } else if (report.evidence.length === 0) {
      reasons.push(`Task ${task.id} dependency report has no evidence`);
    }
  }
  return check("reports", reasons, [`reports=${reports.size}`]);
}

function evaluateRepository(input: CollectedInputs): ValidationCheck {
  const reasons = [...input.repository.discrepancies];
  const { manifest } = input.evidence;
  const repository = input.repository;
  if (
    manifest.repository.id !== repository.repositoryId ||
    manifest.repository.commonDirectory !== repository.commonDirectory ||
    manifest.worktree.path !== repository.worktreePath
  ) reasons.push("Git repository or worktree identity differs from the run manifest");
  const registered = repository.worktrees.find((worktree) => worktree.path === repository.worktreePath);
  if (!registered) reasons.push("Recorded change worktree is not registered with Git");
  else if (registered.head !== repository.head) reasons.push("Registered worktree HEAD differs from the observed HEAD");
  if (repository.status.some((entry) => entry.kind === "unmerged")) reasons.push("Worktree contains unmerged paths");
  if (repository.writerActive || manifest.writer) reasons.push("A source writer is still active");
  if (repository.pendingCheckpointIds.length > 0) reasons.push("Manual checkpoints remain unresolved");
  return check("repository", reasons, [
    `repository=${repository.repositoryId}`,
    `worktree=${repository.worktreePath}`,
    `head=${repository.head}`,
  ]);
}

function failedCollection(gate: FinalValidationGate, reason: unknown): ValidationCheck {
  const message = reason instanceof Error ? reason.message : String(reason);
  return check(gate, [`Required ${gate} input is unavailable: ${message}`], []);
}

export async function runFinalValidation(
  options: RunFinalValidationOptions,
): Promise<FinalValidationResult> {
  const session = createFreshRoleSession(
    options.sessionsRoot,
    options.runId,
    "final-validation",
    "validator",
  );
  const context: FinalValidationContext = {
    runId: options.runId,
    changeName: options.changeName,
    ...session,
    access: "read",
  };
  const collectors = [
    ["openspec", options.dependencies.readOpenSpec],
    ["tasks", options.dependencies.readTasks],
    ["evidence", options.dependencies.readEvidence],
    ["tests", options.dependencies.runTests],
    ["findings", options.dependencies.readFindings],
    ["design", options.dependencies.checkDesign],
    ["freshness", options.dependencies.readFreshness],
    ["reports", options.dependencies.readReports],
    ["repository", options.dependencies.readRepository],
  ] as const;
  const settled = await Promise.allSettled(collectors.map(([, collect]) => collect(context)));
  const collectionFailures = new Map<FinalValidationGate, ValidationCheck>();
  for (let index = 0; index < settled.length; index++) {
    const result = settled[index]!;
    if (result.status === "rejected") {
      collectionFailures.set(collectors[index]![0], failedCollection(collectors[index]![0], result.reason));
    }
  }

  const checks: ValidationCheck[] = [];
  let artifactDigest: string | null = null;
  let sourceDigest: string | null = null;
  if (collectionFailures.size === 0) {
    const inputs: CollectedInputs = {
      openspec: (settled[0] as PromiseFulfilledResult<OpenSpecValidationInput>).value,
      tasks: (settled[1] as PromiseFulfilledResult<readonly FinalValidationTask[]>).value,
      evidence: (settled[2] as PromiseFulfilledResult<PersistedEvidenceInput>).value,
      tests: (settled[3] as PromiseFulfilledResult<TestValidationInput>).value,
      findings: (settled[4] as PromiseFulfilledResult<FindingValidationInput>).value,
      design: (settled[5] as PromiseFulfilledResult<DesignValidationInput>).value,
      freshness: (settled[6] as PromiseFulfilledResult<FreshnessValidationInput>).value,
      reports: (settled[7] as PromiseFulfilledResult<ReportValidationInput>).value,
      repository: (settled[8] as PromiseFulfilledResult<RepositoryValidationInput>).value,
    };
    artifactDigest = inputs.freshness.artifactDigest;
    sourceDigest = inputs.freshness.sourceDigest;
    checks.push(
      evaluateOpenSpec(inputs),
      evaluateTasks(inputs),
      evaluateEvidence(inputs),
      evaluateTests(inputs),
      evaluateFindings(inputs),
      evaluateDesign(inputs),
      evaluateFreshness(inputs),
      evaluateReports(inputs),
      evaluateRepository(inputs),
    );
  } else {
    for (const gate of finalValidationGateSchema.options) {
      checks.push(collectionFailures.get(gate) ?? check(
        gate,
        ["Validation was incomplete because another required input was unavailable"],
        [],
      ));
    }
  }

  const blockingReasons = checks
    .filter((item) => item.status === "FAIL")
    .map((item) => `${item.gate}: ${item.summary}`);
  return finalValidationResultSchema.parse({
    schemaVersion: 1,
    runId: options.runId,
    changeName: options.changeName,
    sessionId: session.sessionId,
    validatedAt: options.dependencies.now?.() ?? new Date().toISOString(),
    access: "read",
    result: blockingReasons.length === 0 ? "PASS" : "FAIL",
    readiness: blockingReasons.length === 0 ? "READY_TO_FINISH" : "BLOCKED",
    artifactDigest,
    sourceDigest,
    checks,
    blockingReasons,
  });
}