import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentRun } from "../../src/agents/run-record.ts";
import { readSourceDigest } from "../../src/execution/change-digests.ts";
import { GitAdapter } from "../../src/execution/git.ts";
import { createTddEvidence } from "../../src/policies/tdd.ts";
import { createTaskCodeReview } from "../../src/review/code-review.ts";
import { samplePlan } from "../planning/sample-plan.ts";

/** The kinds of agent session the harness can start, in the words the session budget uses. */
export type SessionKind = "plan" | "opinion" | "debate" | "builder" | "planning-reviewer" | "task-reviewer";

/** What a substituted child is handed: the fields of a spawn request this wrapper reads. */
export interface ChildRequest {
  run: AgentRun;
  role?: string;
  taskId?: string;
  runId?: string;
  cwd: string;
}

const PLANNING_STAGES: Readonly<Record<string, SessionKind>> = {
  "planning.synthesis": "plan",
  "planning.specialist_opinion": "opinion",
  "planning.debate": "debate",
};

/** A one-task plan, so a change is small enough for the small lane and one builder session is all it needs. */
export function oneTaskPlan() {
  const plan = samplePlan();
  return { ...plan, tasks: [plan.tasks[0]!] };
}

/**
 * Stands in for the agent child process and counts every session it is asked to start, by kind.
 * A session is what one `runAgent` call would have spawned, so the count is the number of model
 * sessions the flow costs, whatever its steps are named. The answers are the ones a working
 * child would give, so the flow runs on to verification.
 */
export function createSessionCounter(options: { plan?: unknown } = {}) {
  const sessions: SessionKind[] = [];
  const kindOf = (request: ChildRequest): SessionKind => {
    if (request.role === "architect") return PLANNING_STAGES[request.taskId ?? ""] ?? "plan";
    if (request.role === "builder") return "builder";
    return request.taskId === "planning.review" ? "planning-reviewer" : "task-reviewer";
  };

  const child = async (request: ChildRequest): Promise<AgentRun> => {
    const kind = kindOf(request);
    sessions.push(kind);
    const { run } = request;
    run.status = "done";
    run.exitCode = 0;
    run.toolNames = ["muster_read"];
    // Small, known usage, so budgets that forecast from recorded usage can still afford the next stage.
    run.tokensIn = 100;
    run.tokensOut = 100;
    run.costUsd = 0.001;
    if (kind === "builder") {
      // A real change inside the task's write scope, so the diff a review sees is not empty.
      const path = resolve(request.cwd, "src", "toolbar.ts");
      await writeFile(path, `${await readFile(path, "utf8").catch(() => "")}export const filtered = true;\n`);
      run.text = JSON.stringify({
        claim: "completed",
        implementationPersisted: true,
        statedFix: "Added the filter",
        tddEvidence: createTddEvidence({
          runId: request.runId ?? "run-add-search",
          taskId: request.taskId ?? "1.1",
          requirements: ["toolbar-search: The toolbar filters items"],
          scenarios: ["Typing filters the list", "Clearing the box restores the list"],
          red: { command: "bun test", exitCode: 1, recordedAt: "2026-09-21T10:00:00.000Z" },
          green: { command: "bun test", exitCode: 0, recordedAt: "2026-09-21T10:01:00.000Z" },
          refactor: [{ command: "bun test", exitCode: 0, recordedAt: "2026-09-21T10:02:00.000Z" }],
          createdAt: "2026-09-21T10:02:00.000Z",
        }),
      });
    } else if (kind === "planning-reviewer") {
      run.text = JSON.stringify({ verdict: "APPROVE", criticalFindings: [], requiredChanges: [], recommendations: [] });
    } else if (kind === "task-reviewer") {
      const { sourceDigest } = await readSourceDigest(new GitAdapter(request.cwd));
      run.text = JSON.stringify(createTaskCodeReview({
        runId: request.runId ?? "run-add-search",
        taskId: request.taskId ?? "1.1",
        reviewedAt: "2026-09-21T10:03:00.000Z",
        model: run.model,
        sourceDigest,
        findings: [],
      }));
    } else {
      run.text = JSON.stringify(options.plan ?? oneTaskPlan());
    }
    return run;
  };

  return {
    sessions,
    child,
    count: (kind: SessionKind) => sessions.filter((started) => started === kind).length,
  };
}
