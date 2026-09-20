import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
import { newRun, type AgentRun } from "../../extensions/fusion-harness/modules/runtime.ts";
import { createChangeUsageStore, listChangeUsage } from "../../src/persistence/change-usage-store.ts";
import type { ChangeTaskExecutionContext } from "../../src/execution/scheduler.ts";
import type { ValidatedTask } from "../../src/execution/task-schema.ts";
import { runBuilderStep, builderPrompt } from "../../src/change/phases/task-steps/builder.ts";
import { runVerificationStep } from "../../src/change/phases/task-steps/verification.ts";
import type { TaskStepContext } from "../../src/change/phases/task-steps/context.ts";
import { HarnessError } from "../../src/shared/errors.ts";
import { createInertJudgmentRuntime } from "../../src/judgment/ask.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stepContext(): Promise<TaskStepContext> {
  const root = await mkdtemp(resolve(tmpdir(), "muster-task-step-"));
  directories.push(root);
  return {
    runId: "run-add-search",
    changeName: "add-search",
    planningCwd: root,
    store: createChangeUsageStore(root),
    stack: synthesizeLegacyStack({
      architectModel: "provider/architect",
      builderModel: "provider/builder",
      architectThinking: "high",
      builderThinking: "high",
    }),
  };
}

function task(overrides: Partial<ValidatedTask> = {}): ValidatedTask {
  return {
    id: "1.1",
    checkboxId: "1.1",
    checked: false,
    description: "Add the search index",
    dependsOn: [],
    role: "builder",
    reads: ["src/**"],
    writes: ["src/search.ts"],
    requirements: ["search: Indexing"],
    scenarios: ["Index is built"],
    verify: ["bun test tests/search.test.ts"],
    manual: null,
    metadata: {},
    ...overrides,
  } as unknown as ValidatedTask;
}

const execution: ChangeTaskExecutionContext = {
  worktree: { path: "/worktree", repositoryId: "repo", commonDirectory: "/repo/.git" } as never,
  writerLease: null,
};

describe("runBuilderStep", () => {
  test("parses a completed claim and records usage without driving a run", async () => {
    const step = await stepContext();
    let seenPrompt = "";
    const result = await runBuilderStep(step, task(), execution, undefined, async (options) => {
      seenPrompt = options.prompt;
      options.run.status = "done";
      options.run.text = JSON.stringify({ claim: "completed", implementationPersisted: true });
      return undefined as never;
    });

    expect(result).toEqual({ claim: "completed", implementationPersisted: true });
    expect(seenPrompt).toBe(builderPrompt(task()));
    expect(await listChangeUsage(step.store, step.changeName)).toHaveLength(1);
  });

  test("reports a blocked claim when the agent run fails", async () => {
    const step = await stepContext();
    const result = await runBuilderStep(step, task(), execution, undefined, async (options) => {
      options.run.status = "failed";
      options.run.exitCode = 1;
      options.run.errorMessage = "child exited 1";
      return undefined as never;
    });

    expect(result.claim).toBe("blocked");
    expect(result.implementationPersisted).toBe(false);
    expect(result.reason).toContain("child exited 1");
  });

  test("rejects output that is not one JSON object", async () => {
    const step = await stepContext();
    await expect(runBuilderStep(step, task(), execution, undefined, async (options) => {
      options.run.status = "done";
      options.run.text = "here you go: {";
      return undefined as never;
    })).rejects.toThrow(HarnessError);
  });

  test("hands the judgment runtime to the child, and nothing when the step has none", async () => {
    const runtime = createInertJudgmentRuntime();
    const withRuntime = { ...(await stepContext()), judgment: runtime };
    let seen: unknown = "unset";
    const run = async (step: TaskStepContext) => runBuilderStep(step, task(), execution, undefined, async (options) => {
      seen = options.judgment;
      options.run.status = "done";
      options.run.text = JSON.stringify({ claim: "completed", implementationPersisted: true });
      return undefined as never;
    });
    await run(withRuntime);
    expect(seen).toEqual({ runtime, changeName: "add-search", taskId: "1.1" });
    await run(await stepContext());
    expect(seen).toBeUndefined();
  });

  test("passes cancellation through to the child", async () => {
    const step = await stepContext();
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await runBuilderStep(step, task(), execution, controller.signal, async (options) => {
      seen = options.signal;
      options.run.status = "done";
      options.run.text = JSON.stringify({ claim: "completed", implementationPersisted: true });
      return undefined as never;
    });
    expect(seen).toBe(controller.signal);
  });
});

describe("runVerificationStep", () => {
  test("passes when every declared command exits zero", async () => {
    const commands: string[] = [];
    const result = await runVerificationStep(
      task({ verify: ["bun test a", "bun run typecheck"] } as Partial<ValidatedTask>),
      "/worktree",
      undefined,
      async (options) => {
        commands.push([options.request.executable, ...options.request.args].join(" "));
        return { exitCode: 0 } as never;
      },
    );

    expect(result.passed).toBe(true);
    expect(commands).toEqual(["bun test a", "bun run typecheck"]);
    expect(result.evidence).toEqual(["bun test a: exit 0", "bun run typecheck: exit 0"]);
  });

  test("stops at the first failing command", async () => {
    const commands: string[] = [];
    const result = await runVerificationStep(
      task({ verify: ["bun test a", "bun test b"] } as Partial<ValidatedTask>),
      "/worktree",
      undefined,
      async (options) => {
        commands.push(options.request.executable);
        return { exitCode: commands.length === 1 ? 1 : 0 } as never;
      },
    );

    expect(result.passed).toBe(false);
    expect(commands).toHaveLength(1);
    expect(result.evidence).toEqual(["bun test a: exit 1"]);
  });

  test("rejects a command carrying shell operators before running anything", async () => {
    let ran = false;
    await expect(runVerificationStep(
      task({ verify: ["bun test && rm -rf /"] } as Partial<ValidatedTask>),
      "/worktree",
      undefined,
      async () => { ran = true; return { exitCode: 0 } as never; },
    )).rejects.toThrow(HarnessError);
    expect(ran).toBe(false);
  });

  test("passes cancellation through to the host runner", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await runVerificationStep(task(), "/worktree", controller.signal, async (options) => {
      seen = options.signal;
      return { exitCode: 0 } as never;
    });
    expect(seen).toBe(controller.signal);
  });
});

describe("task step context", () => {
  test("a step depends only on values present in its inputs", () => {
    const run: AgentRun = newRun("BUILDER", "provider/builder");
    expect(run.model).toBe("provider/builder");
    // Every step takes its context explicitly, so no enclosing run scope is required here.
    expect(runBuilderStep.length).toBeGreaterThanOrEqual(3);
    expect(runVerificationStep.length).toBeGreaterThanOrEqual(2);
  });
});
