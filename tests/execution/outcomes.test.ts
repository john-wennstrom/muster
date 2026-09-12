import { describe, expect, test } from "bun:test";
import { parseTaskDocument } from "../../src/execution/task-parser.ts";
import {
  evaluateTaskOutcome,
  synchronizeTaskCheckbox,
} from "../../src/execution/task-runner.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const taskDocument = `## 1. Foundation

- [ ] 1.1 Implement parser

  \`\`\`yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/**"]
  writes: ["src/**"]
  requirements: ["requirement"]
  scenarios: ["scenario"]
  verify: ["bun test"]
  manual: null
  \`\`\`
`;

describe("task outcomes", () => {
  test("does not accept an agent completion claim without every gate", () => {
    const outcome = evaluateTaskOutcome({
      taskId: "1.1",
      claim: "completed",
      implementationPersisted: true,
      verificationPassed: true,
      taskReviewApproved: false,
      evidencePersisted: true,
    });

    expect(outcome).toEqual({
      status: "blocked",
      taskId: "1.1",
      reason: "task review is not approved",
      synchronizeCheckbox: false,
      invalidatePlanningReview: false,
      blockAffectedBranch: true,
    });
  });

  test("synchronizes a checkbox only after accepted completion evidence", () => {
    const parsed = parseTaskDocument(taskDocument, "tasks.md");
    const outcome = evaluateTaskOutcome({
      taskId: "1.1",
      claim: "completed",
      implementationPersisted: true,
      verificationPassed: true,
      taskReviewApproved: true,
      evidencePersisted: true,
    });

    const updated = synchronizeTaskCheckbox(taskDocument, parsed.tasks[0]!, outcome);

    expect(updated).toContain("- [x] 1.1 Implement parser");
  });

  test("design conflicts invalidate planning review and block affected tasks", () => {
    const outcome = evaluateTaskOutcome({
      taskId: "1.1",
      claim: "design_conflict",
      implementationPersisted: false,
      verificationPassed: false,
      taskReviewApproved: false,
      evidencePersisted: true,
      conflict: {
        evidence: ["Repository API cannot satisfy the approved contract"],
        affectedArtifacts: ["design.md", "specs/api/spec.md"],
        affectedTasks: ["1.1", "1.2"],
        recommendation: "Revise the API requirement",
      },
    });

    expect(outcome).toMatchObject({
      status: "design_conflict",
      synchronizeCheckbox: false,
      invalidatePlanningReview: true,
      blockAffectedBranch: true,
      affectedTasks: ["1.1", "1.2"],
    });
  });

  test("rejects checkbox synchronization for non-completed outcomes", () => {
    const parsed = parseTaskDocument(taskDocument, "tasks.md");
    const blocked = evaluateTaskOutcome({
      taskId: "1.1",
      claim: "blocked",
      implementationPersisted: false,
      verificationPassed: false,
      taskReviewApproved: false,
      evidencePersisted: true,
      reason: "dependency unavailable",
    });

    expect(() => synchronizeTaskCheckbox(taskDocument, parsed.tasks[0]!, blocked)).toThrow(
      expect.objectContaining({ code: "TASK_COMPLETION_INVALID" }) as HarnessError,
    );
  });
});