import { describe, expect, test } from "bun:test";
import { reusableCommands } from "../../src/execution/verification-reuse.ts";
import type { TaskResultRecord } from "../../src/persistence/records.ts";

const digest = "a".repeat(64);
const result = (taskId: string, evidence: string[], overrides: Partial<TaskResultRecord> = {}): TaskResultRecord => ({
  schemaVersion: 1,
  runId: "run-1",
  taskId,
  outcome: "completed",
  sourceDigest: digest,
  verificationEvidence: evidence,
  completedAt: "2026-09-21T10:00:00.000Z",
  ...overrides,
});

describe("reusableCommands", () => {
  const tasks = [{ id: "1.1", verify: ["bun test a", "bun test b"] }];

  test("every command recorded with exit 0 at the current digest is reusable", () => {
    const reusable = reusableCommands(tasks, [result("1.1", ["bun test a: exit 0", "bun test b: exit 0"])], digest);
    expect([...reusable]).toEqual([["bun test a", digest], ["bun test b", digest]]);
  });

  test("a changed source reuses nothing", () => {
    expect(reusableCommands(tasks, [result("1.1", ["bun test a: exit 0", "bun test b: exit 0"])], "b".repeat(64)).size).toBe(0);
  });

  test("a partially matching command list reuses nothing", () => {
    expect(reusableCommands(tasks, [result("1.1", ["bun test a: exit 0"])], digest).size).toBe(0);
    expect(reusableCommands(tasks, [result("1.1", ["bun test a: exit 0", "bun test b: exit 1"])], digest).size).toBe(0);
  });

  test("a task without a completed result, or with no commands, reuses nothing", () => {
    expect(reusableCommands(tasks, [], digest).size).toBe(0);
    expect(reusableCommands(tasks, [result("1.1", ["bun test a: exit 0", "bun test b: exit 0"], { outcome: "failed" as never })], digest).size).toBe(0);
    expect(reusableCommands([{ id: "1.1", verify: [] }], [result("1.1", [])], digest).size).toBe(0);
  });

  test("the latest result of a task is the one that counts", () => {
    const older = result("1.1", ["bun test a: exit 0", "bun test b: exit 0"], { completedAt: "2026-09-21T09:00:00.000Z" });
    const newer = result("1.1", ["bun test a: exit 1"], { completedAt: "2026-09-21T10:00:00.000Z" });
    expect(reusableCommands(tasks, [older, newer], digest).size).toBe(0);
  });

  test("a command is reusable through any task that fully qualifies", () => {
    const two = [{ id: "1.1", verify: ["bun test a"] }, { id: "1.2", verify: ["bun test a", "bun test c"] }];
    const reusable = reusableCommands(two, [result("1.1", ["bun test a: exit 0"]), result("1.2", ["bun test a: exit 0"])], digest);
    expect([...reusable.keys()]).toEqual(["bun test a"]);
  });
});
