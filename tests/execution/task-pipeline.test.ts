import { describe, expect, test } from "bun:test";
import { parseTaskDocument } from "../../src/execution/task-parser.ts";
import { runTaskPipeline } from "../../src/execution/task-runner.ts";
import { createTddEvidence } from "../../src/policies/tdd.ts";

const contents = `## 1. Policy

- [ ] 10.4 Assemble task pipeline

  \`\`\`yaml harness-task
  id: "10.4"
  dependsOn: []
  role: builder
  reads: ["src/**"]
  writes: ["src/**"]
  requirements: ["task-orchestration: Dependency and gate ordering"]
  scenarios: ["Focused test failure"]
  verify: ["bun test tests/execution/task-pipeline.test.ts"]
  manual: null
  \`\`\`
`;

function evidence() {
  return createTddEvidence({
    runId: "run-1",
    taskId: "10.4",
    requirements: ["task-orchestration: Dependency and gate ordering"],
    scenarios: ["Focused test failure"],
    red: { command: "bun test", exitCode: 1, recordedAt: "2026-09-12T12:00:00.000Z" },
    green: { command: "bun test", exitCode: 0, recordedAt: "2026-09-12T12:01:00.000Z" },
    refactor: [{ command: "bun test", exitCode: 0, recordedAt: "2026-09-12T12:02:00.000Z" }],
    createdAt: "2026-09-12T12:02:00.000Z",
  });
}

function options(events: string[]) {
  return {
    runId: "run-1",
    sessionsRoot: "/tmp/muster-sessions",
    contents,
    task: parseTaskDocument(contents, "tasks.md").tasks[0]!,
    behaviorChanging: true,
    requirements: ["task-orchestration: Dependency and gate ordering"],
    scenarios: ["Focused test failure"],
    reviewBudgetAvailable: true,
    runBuilder: async () => {
      events.push("builder");
      return { claim: "completed" as const, implementationPersisted: true, tddEvidence: evidence() };
    },
    runVerification: async () => {
      events.push("verification");
      return { passed: true, evidence: ["bun test: pass"] };
    },
    runReview: async () => {
      events.push("review");
      return { approved: true, findings: [] };
    },
    persistEvidence: async () => {
      events.push("persist");
    },
  };
}

describe("task runner pipeline", () => {
  test("runs every gate in order before synchronizing completion", async () => {
    const events: string[] = [];
    const result = await runTaskPipeline(options(events));

    expect(events).toEqual(["builder", "verification", "review", "persist"]);
    expect(result.outcome.status).toBe("completed");
    expect(result.contents).toContain("- [x] 10.4 Assemble task pipeline");
    expect(result.builderSessionId).toBeTruthy();
  });

  test("stops before review and persistence when focused verification fails", async () => {
    const events: string[] = [];
    const input = options(events);
    input.runVerification = async () => {
      events.push("verification");
      return { passed: false, evidence: ["bun test: fail"] };
    };
    const result = await runTaskPipeline(input);

    expect(events).toEqual(["builder", "verification"]);
    expect(result.outcome).toMatchObject({ status: "blocked", synchronizeCheckbox: false });
    expect(result.contents).toBe(contents);
  });

  test("does not let a completion claim bypass review or budget gates", async () => {
    const events: string[] = [];
    const input = options(events);
    input.reviewBudgetAvailable = false;
    const result = await runTaskPipeline(input);

    expect(events).toEqual(["builder", "verification"]);
    expect(result.outcome).toMatchObject({
      status: "blocked",
      reason: "mandatory task review budget is unavailable",
    });
    expect(result.contents).toBe(contents);
  });
});