import { resolve } from "node:path";
import { z } from "zod";
import { READONLY_TOOLS } from "../../extensions/fusion-harness/modules/runtime.ts";
import { createFreshRoleSession } from "../agents/role-runner.ts";
import { HarnessError } from "../shared/errors.ts";
import type { ReviewModelCandidate } from "./planning-reviewer.ts";

const REVIEW_TOOLS = READONLY_TOOLS.split(",");
const nonEmptyString = z.string().min(1);

const taskCodeReviewFindingSchema = z.object({
  severity: z.enum(["required", "recommendation"]),
  area: z.enum(["contract", "diff", "tests", "scopes", "tdd"]),
  message: nonEmptyString,
}).strict();

export const taskCodeReviewSchema = z.object({
  schemaVersion: z.literal(1),
  runId: nonEmptyString,
  taskId: nonEmptyString,
  reviewedAt: z.string().datetime({ offset: true }),
  model: nonEmptyString,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verdict: z.enum(["APPROVE", "REVISE"]),
  findings: z.array(taskCodeReviewFindingSchema),
}).strict().superRefine((review, context) => {
  const expectedVerdict = review.findings.some((finding) => finding.severity === "required")
    ? "REVISE"
    : "APPROVE";
  if (review.verdict !== expectedVerdict) {
    context.addIssue({
      code: "custom",
      path: ["verdict"],
      message: `Expected ${expectedVerdict} for the reported findings`,
    });
  }
});

export type TaskCodeReview = z.infer<typeof taskCodeReviewSchema>;
export type TaskCodeReviewFinding = z.infer<typeof taskCodeReviewFindingSchema>;

export interface TaskCodeReviewRequest {
  runId: string;
  taskId: string;
  model: string;
  cwd: string;
  prompt: string;
  sessionId: string;
  sessionDir: string;
  access: "read";
  tools: readonly string[];
}

export interface TaskCodeReviewResponse {
  review: TaskCodeReview;
  toolNames: readonly string[];
}

export type TaskCodeReviewerRunner = (
  request: TaskCodeReviewRequest,
) => Promise<TaskCodeReviewResponse>;

export interface TaskCodeReviewDispatchOptions {
  runId: string;
  taskId: string;
  cwd: string;
  sessionsRoot: string;
  author: { model: string; sessionId?: string };
  candidates: readonly ReviewModelCandidate[];
  contract: {
    definition: string;
    requirements: readonly string[];
    scenarios: readonly string[];
  };
  diff: { digest: string; summary: string };
  tests: readonly string[];
  scopes: {
    reads: readonly string[];
    writes: readonly string[];
    violations: readonly string[];
  };
  tddEvidence: unknown;
  runner: TaskCodeReviewerRunner;
}

export interface TaskCodeReviewDispatchResult {
  review: TaskCodeReview;
  assignment: {
    reviewerModel: string;
    reviewerSessionId: string;
    differentModelAssigned: boolean;
    access: "read";
    tools: readonly string[];
  };
  decision:
    | { status: "approved"; findings: [] }
    | { status: "repair"; findings: string[] };
}

export function createTaskCodeReview(
  input: Omit<TaskCodeReview, "schemaVersion" | "verdict">,
): TaskCodeReview {
  return taskCodeReviewSchema.parse({
    schemaVersion: 1,
    ...input,
    verdict: input.findings.some((finding) => finding.severity === "required")
      ? "REVISE"
      : "APPROVE",
  });
}

function section(heading: string, value: unknown): string {
  return `${heading}\n${JSON.stringify(value, null, 2)}`;
}

export function renderTaskCodeReviewPrompt(
  options: TaskCodeReviewDispatchOptions,
): string {
  return [
    `Review task ${options.taskId}. Return required findings for any correctness, scope, test, or TDD defect.`,
    section("TASK CONTRACT", options.contract),
    section("IMPLEMENTATION DIFF", options.diff),
    section("TEST EVIDENCE", options.tests),
    section("AUTHORIZED SCOPES", options.scopes),
    section("TDD EVIDENCE", options.tddEvidence),
    "Return exactly one task code review object. Do not modify the repository.",
  ].join("\n\n");
}

function selectReviewer(
  candidates: readonly ReviewModelCandidate[],
  authorModel: string,
): ReviewModelCandidate {
  const available = candidates.filter((candidate) => candidate.available);
  const selected = available.find((candidate) => candidate.model !== authorModel) ?? available[0];
  if (!selected) {
    throw new HarnessError(
      "REVIEW_MODEL_UNAVAILABLE",
      "No eligible task review model is available",
      { taskId: undefined, authorModel, candidates },
    );
  }
  return selected;
}

export async function dispatchTaskCodeReview(
  options: TaskCodeReviewDispatchOptions,
): Promise<TaskCodeReviewDispatchResult> {
  const reviewer = selectReviewer(options.candidates, options.author.model);
  const tools = reviewer.readTools ?? REVIEW_TOOLS;
  const reviewToolSet = new Set([...tools, "muster_read", "muster_search"]);
  const session = createFreshRoleSession(
    resolve(options.sessionsRoot, "task-review"),
    options.runId,
    options.taskId,
    "reviewer",
  );
  if (session.sessionId === options.author.sessionId) {
    throw new HarnessError(
      "REVIEW_TOOL_DENIED",
      "Task reviewer session must not reuse the author session",
      { taskId: options.taskId, sessionId: session.sessionId },
    );
  }
  const response = await options.runner({
    runId: options.runId,
    taskId: options.taskId,
    model: reviewer.model,
    cwd: options.cwd,
    prompt: renderTaskCodeReviewPrompt(options),
    ...session,
    access: "read",
    tools,
  });
  const deniedTools = [...new Set(response.toolNames.filter((tool) => !reviewToolSet.has(tool)))];
  if (deniedTools.length > 0) {
    throw new HarnessError(
      "REVIEW_TOOL_DENIED",
      `Task reviewer attempted non-read-only tools: ${deniedTools.join(", ")}`,
      { taskId: options.taskId, sessionId: session.sessionId, deniedTools },
    );
  }
  const parsed = taskCodeReviewSchema.safeParse(response.review);
  if (
    !parsed.success ||
    parsed.data.runId !== options.runId ||
    parsed.data.taskId !== options.taskId ||
    parsed.data.model !== reviewer.model ||
    parsed.data.sourceDigest !== options.diff.digest
  ) {
    throw new HarnessError(
      "REVIEW_ARTIFACT_INVALID",
      "Task reviewer returned invalid or mismatched review evidence",
      { taskId: options.taskId, issues: parsed.success ? [] : parsed.error.issues },
    );
  }
  const requiredFindings = parsed.data.findings
    .filter((finding) => finding.severity === "required")
    .map((finding) => finding.message);
  return {
    review: parsed.data,
    assignment: {
      reviewerModel: reviewer.model,
      reviewerSessionId: session.sessionId,
      differentModelAssigned: reviewer.model !== options.author.model,
      access: "read",
      tools,
    },
    decision: requiredFindings.length > 0
      ? { status: "repair", findings: requiredFindings }
      : { status: "approved", findings: [] },
  };
}
