import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readLane } from "../../src/controller/lane.ts";
import { latestFailure } from "../../src/execution/recovery.ts";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type { JudgmentAnswers, JudgmentClient } from "../../src/judgment/client.ts";
import { TASK_RECOVERY_QUESTION_IDS as IDS } from "../../src/judgment/questions.ts";
import type { UnitSteps } from "../../src/execution/unit-runner.ts";
import { createDeadClient, createScriptedClient } from "../helpers/scripted-judgment.ts";
import { setup, type UnitFixtureOptions } from "../helpers/unit-fixture.ts";

const enforce = { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: "enforce" };
const shadow = { ...enforce, MUSTER_JEV_MODE: "shadow" };

const answer = (choice: string, confidence = 0.95): JudgmentAnswers => ({
  [IDS.nextStep]: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence },
  [IDS.humanNeeded]: { type: "noul", noul: 0.1 },
});

const failedVerification: Partial<UnitSteps> = {
  runVerification: async () => ({
    passed: false,
    evidence: ["bun test tests/search.test.ts: exit 1"],
    failure: { command: "bun test tests/search.test.ts", exitCode: 1, output: "Expected 1, received 0" },
  }),
};

async function fixture(
  client: JudgmentClient | null,
  env: Record<string, string>,
  steps: Partial<UnitSteps> = failedVerification,
  options: UnitFixtureOptions = {},
) {
  // The runtime needs the fixture's store, and the fixture needs the runtime, so the first is a shell.
  let runtime: ReturnType<typeof createJudgmentRuntime> | undefined;
  const lazy = {
    get enabled() { return runtime!.enabled; },
    askJev: (request: Parameters<NonNullable<typeof runtime>["askJev"]>[0]) => runtime!.askJev(request),
    judge: ((decision: never, request: never) => runtime!.judge(decision, request)) as NonNullable<typeof runtime>["judge"],
    reconcile: (...args: Parameters<NonNullable<typeof runtime>["reconcile"]>) => runtime!.reconcile(...args),
  };
  const subject = await setup(false, steps, { ...options, judgment: client ? lazy : undefined });
  if (client) runtime = createJudgmentRuntime({ env, store: subject.store, client });
  return subject;
}

const records = (subject: Awaited<ReturnType<typeof fixture>>) => listDecisionRecords(subject.store, "add-search");

describe("a failed attempt is recorded, whatever judgment does", () => {
  test("without judgment a blocked outcome is final and the failure is recorded", async () => {
    const subject = await fixture(null, {});

    const result = await subject.run();

    expect(result.outcome).toBe("blocked");
    const failure = await latestFailure(subject.store, "add-search", "1.1");
    expect(failure).toMatchObject({
      attempt: 1,
      outcome: "blocked",
      reproduction: { command: "bun test tests/search.test.ts", exitCode: 1, outputTail: "Expected 1, received 0" },
    });
  });

  test("a thrown attempt still throws for the scheduler to retry, and is recorded", async () => {
    const subject = await fixture(null, {}, { runBuilder: async () => { throw new Error("session died"); } });

    await expect(subject.run()).rejects.toThrow("session died");

    expect(await latestFailure(subject.store, "add-search", "1.1")).toMatchObject({ outcome: "error", evidence: ["session died"] });
  });

  test("a completed task records no failure", async () => {
    const subject = await fixture(null, {}, {});
    expect((await subject.run()).outcome).toBe("completed");
    expect(await latestFailure(subject.store, "add-search", "1.1")).toBeNull();
  });
});

describe("task.recovery in enforce mode", () => {
  test("a confident retry after failed verification returns a failed result so the scheduler retries", async () => {
    const client = createScriptedClient({ "task.recovery": answer("retry") });
    const subject = await fixture(client, enforce);

    const result = await subject.run(1);

    expect(result.outcome).toBe("failed");
    expect(client.requests).toHaveLength(1);
    expect(subject.recoveryEnds).toEqual([]);
    expect((await records(subject))[0]?.observed).toMatchObject({ action: "retry", attempt: 1 });
  });

  test("a retry is never chosen at the attempt limit", async () => {
    const client = createScriptedClient({ "task.recovery": answer("retry") });
    const subject = await fixture(client, enforce);

    const result = await subject.run(2);

    expect(result.outcome).toBe("blocked");
    expect((await records(subject))[0]?.observed).toMatchObject({ action: "none", attempt: 2 });
  });

  test("a retry is not chosen when the builder itself said blocked", async () => {
    const client = createScriptedClient({ "task.recovery": answer("retry") });
    const subject = await fixture(client, enforce, {
      runBuilder: async () => ({ claim: "blocked", implementationPersisted: false, reason: "no access" }),
    });

    expect((await subject.run(1)).outcome).toBe("blocked");
  });

  test("a retry follows required reviewer repairs", async () => {
    const client = createScriptedClient({ "task.recovery": answer("retry") });
    const subject = await fixture(client, enforce, { runReview: async () => ({ approved: false, findings: ["Handle empty input"] }) });

    expect((await subject.run(1)).outcome).toBe("failed");
    expect(await latestFailure(subject.store, "add-search", "1.1")).toMatchObject({ evidence: ["Handle empty input"] });
  });

  test("escalate promotes the lane, leaves the task ready and records why", async () => {
    const client = createScriptedClient({ "task.recovery": answer("escalate") });
    const subject = await fixture(client, enforce, failedVerification, { lane: "small" });

    const result = await subject.run();

    expect(result.outcome).toBe("blocked");
    expect((await readLane(subject.store, "add-search")).lane).toBe("medium");
    expect(subject.keeper.current).toMatchObject({ lane: "medium", tasks: { "1.1": "ready" } });
    expect(subject.recoveryEnds).toMatchObject([{ taskId: "1.1", kind: "escalate", lane: "medium" }]);
  });

  test("escalate on the large lane has nowhere to go and changes nothing", async () => {
    const client = createScriptedClient({ "task.recovery": answer("escalate") });
    const subject = await fixture(client, enforce, failedVerification, { lane: "large" });

    expect((await subject.run()).outcome).toBe("blocked");
    expect(subject.recoveryEnds).toEqual([]);
    expect((await readLane(subject.store, "add-search")).lane).toBe("large");
  });

  test("stop ends the task with the reason and the failure record's path", async () => {
    const client = createScriptedClient({ "task.recovery": answer("stop") });
    const subject = await fixture(client, enforce);

    const result = await subject.run();

    expect(result.outcome).toBe("blocked");
    expect(subject.recoveryEnds).toMatchObject([{ taskId: "1.1", kind: "stop", failurePath: ".fusion/runs/run-add-search/failures/1.1.json" }]);
    expect(subject.keeper.current.tasks["1.1"]).toBe("blocked");
    expect(JSON.parse(await readFile(resolve(subject.root, subject.recoveryEnds[0]!.failurePath), "utf8")).taskId).toBe("1.1");
  });

  test("an uncertain answer changes nothing", async () => {
    const client = createScriptedClient({ "task.recovery": answer("stop", 0.5) });
    const subject = await fixture(client, enforce);

    expect((await subject.run()).outcome).toBe("blocked");
    expect(subject.recoveryEnds).toEqual([]);
  });

  test("an unavailable service changes nothing", async () => {
    const subject = await fixture(createDeadClient("network"), enforce);

    expect((await subject.run(1)).outcome).toBe("blocked");
    expect(subject.recoveryEnds).toEqual([]);
  });

  test("a thrown attempt that the decision stops ends blocked instead of throwing", async () => {
    const client = createScriptedClient({ "task.recovery": answer("stop") });
    const subject = await fixture(client, enforce, { runBuilder: async () => { throw new Error("credential missing"); } });

    expect((await subject.run(1)).outcome).toBe("blocked");
  });

  test("one request is made per failed attempt", async () => {
    const client = createScriptedClient({ "task.recovery": answer("retry") });
    const subject = await fixture(client, enforce);

    await subject.run(1);
    await subject.run(2);

    expect(client.requests).toHaveLength(2);
  });
});

describe("task.recovery in shadow mode", () => {
  test("behavior is unchanged and the record shows what happened", async () => {
    const client = createScriptedClient({ "task.recovery": answer("retry") });
    const subject = await fixture(client, shadow);

    const result = await subject.run(1);

    expect(result.outcome).toBe("blocked");
    expect(subject.recoveryEnds).toEqual([]);
    const [record] = await records(subject);
    expect(record?.observed).toMatchObject({ action: "none", outcome: "blocked" });
  });
});
