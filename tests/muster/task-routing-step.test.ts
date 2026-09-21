import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import { economyBuilderSlot } from "../../src/change/models.ts";
import { builderPrompt, runBuilderStep } from "../../src/change/phases/task-steps/builder.ts";
import type { TaskStepContext } from "../../src/change/phases/task-steps/context.ts";
import type { ChangeTaskExecutionContext } from "../../src/execution/scheduler.ts";
import type { ValidatedTask } from "../../src/execution/task-schema.ts";
import { createInertJudgmentRuntime, createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type {
  JudgmentAnswers,
  JudgmentClient,
  JudgmentClientRequest,
  JudgmentUnavailableReason,
} from "../../src/judgment/client.ts";
import { TASK_ROUTING_QUESTION_IDS as IDS, TASK_ROUTING_RISK_QUESTION_IDS } from "../../src/judgment/questions.ts";
import { createChangeUsageStore, listChangeUsage } from "../../src/persistence/change-usage-store.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const scored = (score: number, confidence: number) => ({
  type: "score" as const,
  score,
  probabilities: { "0": 1 - confidence },
  confidence,
});
const routable: JudgmentAnswers = {
  [IDS.mechanical]: noul(0.9),
  ...Object.fromEntries(TASK_ROUTING_RISK_QUESTION_IDS.map((id) => [id, noul(0.1)])),
  [IDS.reach]: scored(0.4, 0.9),
};
const notRoutable: JudgmentAnswers = { ...routable, [IDS.securityBoundary]: noul(0.5) };

const stack = synthesizeLegacyStack({
  architectModel: "provider/architect",
  builderModel: "provider/primary",
  architectThinking: "high",
  builderThinking: "high",
});
const lane = economyBuilderSlot(stack, { MUSTER_BUILDER_ECONOMY_MODEL: "provider/economy" })!;

const task = {
  id: "1.1",
  checkboxId: "1.1",
  checked: false,
  description: "Rename the flag",
  dependsOn: ["0.1"],
  role: "builder",
  reads: ["src/**"],
  writes: ["src/cli.ts"],
  requirements: ["cli: Flag renamed"],
  scenarios: ["Renamed flag works"],
  verify: ["bun test tests/cli.test.ts"],
  manual: null,
  metadata: { id: "1.1" },
} as unknown as ValidatedTask;

const execution: ChangeTaskExecutionContext = {
  worktree: { path: "/worktree", repositoryId: "repo", commonDirectory: "/repo/.git" } as never,
  writerLease: null,
};

const enforcing = { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: "enforce", MUSTER_JEV_MODEL_ROUTING: "1" };

type Reply = JudgmentAnswers | JudgmentUnavailableReason;

async function fixture(options: {
  env?: Record<string, string>;
  reply?: Reply;
  lane?: boolean;
  inert?: boolean;
  noRuntime?: boolean;
} = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-task-routing-"));
  directories.push(root);
  const store = createChangeUsageStore(root);
  const requests: JudgmentClientRequest[] = [];
  const reply = options.reply ?? routable;
  const client: JudgmentClient = {
    async request(request) {
      requests.push(request);
      return typeof reply === "string"
        ? { available: false, reason: reply, durationMs: 1 }
        : { available: true, answers: reply, model: "jev-1", inputTokens: 100, durationMs: 5 };
    },
  } as JudgmentClient;
  const step: TaskStepContext = {
    runId: "run-add-search",
    changeName: "add-search",
    planningCwd: root,
    store,
    stack,
    ...(options.noRuntime ? {} : {
      judgment: options.inert
        ? createInertJudgmentRuntime()
        : createJudgmentRuntime({ env: options.env ?? enforcing, store, client }),
    }),
    ...(options.lane === false ? {} : { economyBuilder: lane }),
  };
  const seen: { model?: string; thinking?: string; prompt?: string; systemPrompt?: string; timeoutMs?: number; run?: unknown }[] = [];
  const run = (attempt?: number) => runBuilderStep(step, task, execution, undefined, async (child) => {
    seen.push({
      model: child.run.model,
      thinking: child.thinking,
      prompt: child.prompt,
      systemPrompt: child.systemPrompt,
      timeoutMs: child.timeoutMs,
      run: child.run.slot,
    });
    child.run.status = "done";
    child.run.text = JSON.stringify({ claim: "completed", implementationPersisted: true });
    return undefined as never;
  }, attempt);
  return { step, store, requests, seen, run };
}

describe("task routing in the builder step", () => {
  test("a first attempt the gate routes runs on the economy lane, in enforce mode only", async () => {
    const subject = await fixture();
    const result = await subject.run(1);
    expect(result).toEqual({ claim: "completed", implementationPersisted: true });
    expect(subject.requests).toHaveLength(1);
    expect(subject.seen[0]!.model).toBe("provider/economy");
    // Usage names the model that ran, so the price difference is derivable from existing records.
    const usage = await listChangeUsage(subject.store, "add-search");
    expect(usage.filter((record) => record.role === "builder").map((record) => record.model)).toEqual(["economy"]);
  });

  test("the lane differs from the primary builder only in the model", async () => {
    const economy = await fixture();
    await economy.run(1);
    const primary = await fixture({ reply: notRoutable });
    await primary.run(1);
    const [routed, plain] = [economy.seen[0]!, primary.seen[0]!];
    expect(plain.model).toBe("provider/primary");
    expect({ ...routed, model: undefined, run: undefined }).toEqual({ ...plain, model: undefined, run: undefined });
    expect({ ...(routed.run as object), model: undefined }).toEqual({ ...(plain.run as object), model: undefined });
  });

  test("the builder's prompt, timeout, and result handling are unchanged", async () => {
    const subject = await fixture();
    await subject.run(1);
    expect(subject.seen[0]!.prompt).toBe(builderPrompt(task));
    expect(subject.seen[0]!.timeoutMs).toBe(8 * 60 * 60 * 1000);
  });

  test("a task the gate does not route stays on the primary builder", async () => {
    const subject = await fixture({ reply: notRoutable });
    await subject.run(1);
    expect(subject.requests).toHaveLength(1);
    expect(subject.seen[0]!.model).toBe("provider/primary");
  });

  test("every unavailable reason uses the primary builder", async () => {
    const reasons: JudgmentUnavailableReason[] = ["timeout", "invalid_response", "model_mismatch", "network", "rate_limit", "server", "aborted"];
    for (const reason of reasons) {
      const subject = await fixture({ reply: reason });
      await subject.run(1);
      expect(subject.seen[0]!.model).toBe("provider/primary");
    }
  });

  test("a budget refusal uses the primary builder", async () => {
    const subject = await fixture();
    const runtime = createJudgmentRuntime({
      env: enforcing,
      store: subject.step.store,
      client: { async request() { throw new Error("must not be asked"); } } as unknown as JudgmentClient,
      budget: { forecast: () => ({ status: "blocked", reason: "over budget" }) } as never,
    });
    const step = { ...subject.step, judgment: runtime };
    let ran = false;
    await runBuilderStep(step, task, execution, undefined, async (child) => {
      ran = true;
      expect(child.run.model).toBe("provider/primary");
      child.run.status = "done";
      child.run.text = JSON.stringify({ claim: "completed", implementationPersisted: true });
      return undefined as never;
    }, 1);
    expect(ran).toBe(true);
    const [record] = await listDecisionRecords(subject.step.store, "add-search");
    expect(record).toMatchObject({ status: "unavailable", unavailableReason: "budget" });
  });

  test("shadow mode uses the primary builder and records the lane it would have chosen", async () => {
    const subject = await fixture({ env: { ...enforcing, MUSTER_JEV_MODE: "shadow" } });
    await subject.run(1);
    expect(subject.seen[0]!.model).toBe("provider/primary");
    const [record] = await listDecisionRecords(subject.step.store, "add-search");
    expect(record).toMatchObject({ decision: "routing.task_model", taskId: "1.1", mode: "shadow", wouldHaveActed: true, acted: false });
    expect(record!.gate).toMatchObject({ act: true, value: { lane: "economy" } });
  });

  test("a retry uses the primary builder and sends no request", async () => {
    const subject = await fixture();
    await subject.run(2);
    await subject.run(3);
    expect(subject.requests).toHaveLength(0);
    expect(subject.seen.map((seen) => seen.model)).toEqual(["provider/primary", "provider/primary"]);
  });

  test("an omitted attempt is a first attempt, so existing callers are unchanged", async () => {
    const subject = await fixture();
    await subject.run();
    expect(subject.seen[0]!.model).toBe("provider/economy");
  });

  test("without the routing flag, no request is sent", async () => {
    const { MUSTER_JEV_MODEL_ROUTING: _flag, ...withoutFlag } = enforcing;
    const subject = await fixture({ env: withoutFlag });
    await subject.run(1);
    expect(subject.requests).toHaveLength(0);
    expect(subject.seen[0]!.model).toBe("provider/primary");
    expect(await listDecisionRecords(subject.step.store, "add-search")).toEqual([]);
  });

  test("without an economy lane, no request is sent", async () => {
    const subject = await fixture({ lane: false });
    await subject.run(1);
    expect(subject.requests).toHaveLength(0);
    expect(subject.seen[0]!.model).toBe("provider/primary");
  });

  test("with judgment disabled or absent, no request is sent and no record is written", async () => {
    for (const options of [{ inert: true }, { noRuntime: true }, { env: {} }]) {
      const subject = await fixture(options);
      await subject.run(1);
      expect(subject.requests).toHaveLength(0);
      expect(subject.seen[0]!.model).toBe("provider/primary");
      expect(await listDecisionRecords(subject.step.store, "add-search")).toEqual([]);
    }
  });

  test("the state sent holds only the task contract", async () => {
    const subject = await fixture();
    await subject.run(1);
    expect(subject.requests[0]!.state).toEqual({
      description: "Rename the flag",
      requirements: ["cli: Flag renamed"],
      scenarios: ["Renamed flag works"],
      reads: ["src/**"],
      writes: ["src/cli.ts"],
      verify: ["bun test tests/cli.test.ts"],
    });
    expect(subject.requests[0]!.decision).toEqual({ id: "routing.task_model", version: 1 });
  });
});
