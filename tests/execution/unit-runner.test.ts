import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { setup } from "../helpers/unit-fixture.ts";

describe("createUnitRunner", () => {
  test("a builder task runs each step in order and persists its evidence", async () => {
    const subject = await setup(false, {});

    const result = await subject.run();

    expect(result).toEqual({ outcome: "completed", error: undefined });
    expect(subject.calls).toEqual(["builder:1", "verification", "review"]);
    expect(await subject.read("task-results/1.1.json")).toMatchObject({ outcome: "completed", verificationEvidence: ["bun test tests/search.test.ts: pass"] });
    expect(await subject.read("reviews/task-1.1.json")).toMatchObject({ verdict: "APPROVE", model: "openai/reviewer" });
    expect(await subject.read("tdd/1.1.json")).toMatchObject({ taskId: "1.1" });
    expect(await subject.read("reports/1.1.json")).toMatchObject({ taskId: "1.1", outcome: "completed" });
    expect(await readFile(subject.tasksPath, "utf8")).toMatch(/- \[x\] 1\.1 /);
    expect(subject.keeper.current.tasks["1.1"]).toBe("completed");
  });

  test("passes the attempt number to the builder step", async () => {
    const subject = await setup(false, {});
    await subject.run(2);
    expect(subject.calls[0]).toBe("builder:2");
  });

  test("failed verification stops the task before review and leaves it unchecked", async () => {
    const subject = await setup(false, {
      runVerification: async () => ({ passed: false, evidence: ["bun test tests/search.test.ts: fail"] }),
    });

    const result = await subject.run();

    expect(result.outcome).not.toBe("completed");
    expect(subject.calls).not.toContain("review");
    expect(await readFile(subject.tasksPath, "utf8")).toMatch(/- \[ \] 1\.1 /);
    expect(subject.keeper.current.tasks["1.1"]).not.toBe("completed");
  });

  test("a planned manual task checkpoints instead of building", async () => {
    const subject = await setup(true, {});

    const result = await subject.run();

    expect(result).toEqual({ outcome: "awaiting_user" });
    expect(subject.calls).toEqual([]);
    expect(subject.pendingCheckpoints).toHaveLength(1);
    expect(subject.pendingCheckpoints[0]).toMatchObject({ taskId: "1.1", status: "pending" });
    expect(subject.keeper.current).toMatchObject({ lifecycle: "AWAITING_USER", tasks: { "1.1": "awaiting_user" } });
  });

  test("a throwing builder attempt propagates so the scheduler can retry", async () => {
    const subject = await setup(false, { runBuilder: async () => { throw new Error("session died"); } });
    await expect(subject.run()).rejects.toThrow("session died");
  });

  test("a skipped review is recorded as skipped, on a judgment basis naming its decision record", async () => {
    const subject = await setup(false, { runReview: async () => ({ approved: true, findings: [], skipped: { decisionRecordId: "rec-1" } }) });

    expect((await subject.run()).outcome).toBe("completed");

    expect(await subject.read("reviews/task-1.1.json")).toMatchObject({ verdict: "APPROVE", model: "skipped", basis: "judgment", judgmentRecordId: "rec-1" });
  });

  test("a reviewer approval keeps the reviewer's model and no judgment basis", async () => {
    const subject = await setup(false, {});
    await subject.run();
    const record = await subject.read("reviews/task-1.1.json");
    expect(record.model).toBe("openai/reviewer");
    expect(record.basis).toBeUndefined();
  });
});
