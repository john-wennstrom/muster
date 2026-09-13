import { describe, expect, test } from "bun:test";
import { runFreshRoleTask, type FreshRoleTaskRequest } from "../../src/agents/role-runner.ts";
import { createDependencyReport } from "../../src/agents/reports.ts";
import { createFreshRoleSession } from "../../src/agents/role-runner.ts";

describe("fresh role contexts", () => {
  test("consecutive builder tasks use distinct sessions and only structured dependency reports", async () => {
    const requests: FreshRoleTaskRequest[] = [];
    const execute = async (request: FreshRoleTaskRequest) => {
      requests.push(request);
      return { transcript: `private transcript for ${request.taskId}` };
    };
    const first = await runFreshRoleTask({
      runId: "run-1",
      taskId: "1.1",
      role: "builder",
      sessionsRoot: "/tmp/muster-fresh-context",
      prompt: "Implement task 1.1",
      execute,
    });
    const report = createDependencyReport({
      schemaVersion: 1,
      runId: "run-1",
      taskId: "1.1",
      outcome: "completed",
      summary: "Added the parser contract.",
      changedInterfaces: ["parseTask(input): Task"],
      evidence: ["bun test tests/parser.test.ts"],
      createdAt: "2026-09-12T12:00:00.000Z",
    });
    await runFreshRoleTask({
      runId: "run-1",
      taskId: "1.2",
      role: "builder",
      sessionsRoot: "/tmp/muster-fresh-context",
      prompt: "Implement task 1.2",
      dependencyReports: [report],
      execute,
    });

    expect(requests[0]?.sessionId).not.toBe(requests[1]?.sessionId);
    expect(requests[0]?.sessionDir).not.toBe(requests[1]?.sessionDir);
    expect(requests[1]?.prompt).toContain("Added the parser contract.");
    expect(requests[1]?.prompt).toContain("parseTask(input): Task");
    expect(requests[1]?.prompt).not.toContain(first.transcript);
  });

  test("rejects transcript-shaped or unbounded dependency reports", async () => {
    await expect(runFreshRoleTask({
      runId: "run-1",
      taskId: "1.2",
      role: "builder",
      sessionsRoot: "/tmp/muster-fresh-context",
      prompt: "Implement task 1.2",
      dependencyReports: [{
        schemaVersion: 1,
        runId: "run-1",
        taskId: "1.1",
        outcome: "completed",
        summary: "ok",
        changedInterfaces: [],
        evidence: [],
        createdAt: "2026-09-12T12:00:00.000Z",
        transcript: "must not cross task boundaries",
      } as never],
      execute: async () => null,
    })).rejects.toThrow();
  });

  test("fresh role session paths are task-scoped and never carry resume or fork state", () => {
    const first = createFreshRoleSession("/tmp/sessions", "run-1", "1.1", "builder");
    const second = createFreshRoleSession("/tmp/sessions", "run-1", "1.2", "builder");

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.sessionDir).toContain("/run-1/1.1/builder/");
    expect(second.sessionDir).toContain("/run-1/1.2/builder/");
    expect(first).not.toHaveProperty("resume");
    expect(first).not.toHaveProperty("fork");
  });
});