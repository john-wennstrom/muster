import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import {
  createInertJudgmentRuntime,
  createJudgmentRuntime,
  type JudgmentRuntime,
  type JudgmentVerdict,
} from "../../src/judgment/ask.ts";
import type { JudgmentClient, JudgmentClientRequest } from "../../src/judgment/client.ts";
import { abstain, act, type CommandGateValue } from "../../src/judgment/gates.ts";
import { COMMAND_UNCERTAIN_NONE_REASON } from "../../src/judgment/gates.ts";
import { COMMAND_CATEGORIES, COMMAND_QUESTION_IDS } from "../../src/judgment/questions.ts";
import {
  COMMAND_JUDGMENT_CACHE_SIZE,
  COMMAND_JUDGMENT_DEADLINE_MS,
  classifyCommand,
} from "../../src/tools/command-approval.ts";
import { classifyProhibitedCommand, type StructuredCommandRequest } from "../../src/tools/host-runner.ts";

const worktreePath = resolve("/work/tree");
const command = (overrides: Partial<StructuredCommandRequest> = {}): StructuredCommandRequest => ({
  profile: "verification",
  executable: "npm",
  args: ["run", "deploy"],
  cwd: worktreePath,
  ...overrides,
});

const ruleDenied: readonly StructuredCommandRequest[] = [
  command({ executable: "sudo", args: ["ls"] }),
  command({ executable: "npm", args: ["login"] }),
  command({ executable: "git", args: ["push", "--force"] }),
  command({ executable: "npm", args: ["publish"] }),
];

/** A judgment double: answers from `verdict`, counts every call, keeps every request. */
function double(verdict: (call: number) => JudgmentVerdict<CommandGateValue> | Promise<JudgmentVerdict<CommandGateValue>>) {
  const calls: Array<{ state: unknown; deadlineMs?: number; taskId?: string; changeName: string }> = [];
  const runtime = {
    enabled: true,
    async askJev() {
      throw new Error("classifier must use judge");
    },
    async judge(_decision: unknown, request: { state: unknown; deadlineMs?: number; taskId?: string; changeName: string }) {
      calls.push(request);
      return verdict(calls.length);
    },
  } as unknown as JudgmentRuntime;
  return { runtime, calls };
}

const enforced = (category: CommandGateValue["category"], confidence = 0.9): JudgmentVerdict<CommandGateValue> => ({
  kind: "enforce",
  outcome: act({ category, confidence }),
  recordId: "record-1",
});
const noneVerdict = (reason = "none"): JudgmentVerdict<CommandGateValue> => ({
  kind: "enforce",
  outcome: abstain(reason),
  recordId: "record-2",
});

const judgment = (runtime: JudgmentRuntime) => ({ runtime, changeName: "change-1", taskId: "1.1" });

describe("command classifier: rules first", () => {
  test("a rule-denied command is never sent and keeps its rule category", async () => {
    const { runtime, calls } = double(() => noneVerdict());
    for (const request of ruleDenied) {
      const result = await classifyCommand(request, { worktreePath, judgment: judgment(runtime) });
      expect(result).toEqual({ category: classifyProhibitedCommand(request)!, source: "rule" });
    }
    expect(calls).toHaveLength(0);
  });

  test("property: over every judgment answer, a rule-denied command is never sent and never allowed", async () => {
    const answers: Array<JudgmentVerdict<CommandGateValue>> = [
      ...COMMAND_CATEGORIES.filter((name) => name !== "none").flatMap((category) =>
        [0, 0.4, 0.7, 1].map((confidence) => enforced(category as CommandGateValue["category"], confidence))),
      ...[0, 0.5, 0.7, 1].map((confidence) =>
        noneVerdict(confidence < 0.7 ? `${COMMAND_UNCERTAIN_NONE_REASON} (${confidence})` : "none")),
      { kind: "shadow", recordId: null },
      { kind: "fallback", reason: "network", recordId: null },
    ];
    for (const answer of answers) {
      const { runtime, calls } = double(() => answer);
      for (const request of ruleDenied) {
        const result = await classifyCommand(request, { worktreePath, judgment: judgment(runtime) });
        expect(result.category).toBe(classifyProhibitedCommand(request)!);
        expect(result.source).toBe("rule");
      }
      expect(calls).toHaveLength(0);
    }
  });

  test("property: over every judgment answer, a command the rules allow can only gain a category", async () => {
    const request = command();
    expect(classifyProhibitedCommand(request)).toBeNull();
    for (const category of COMMAND_CATEGORIES.filter((name) => name !== "none")) {
      for (const confidence of [0, 0.4, 0.7, 1]) {
        const { runtime } = double(() => enforced(category as CommandGateValue["category"], confidence));
        expect(await classifyCommand(request, { worktreePath, judgment: judgment(runtime) })).toEqual({
          category,
          source: "judgment",
          confidence,
          recordId: "record-1",
        });
      }
    }
  });

  test("without judgment the result is the rules' alone", async () => {
    expect(await classifyCommand(command(), { worktreePath })).toEqual({
      category: null,
      source: null,
      uncertainNone: false,
    });
    expect(await classifyCommand(ruleDenied[0]!, { worktreePath })).toEqual({
      category: "elevated_permission",
      source: "rule",
    });
  });
});

describe("command classifier: proceeding", () => {
  test("none, shadow, and unavailable all proceed", async () => {
    for (const verdict of [
      noneVerdict(),
      { kind: "shadow", recordId: "r" } as const,
      { kind: "fallback", reason: "timeout", recordId: null } as const,
      { kind: "fallback", reason: "budget", recordId: "r" } as const,
    ]) {
      const { runtime } = double(() => verdict);
      const result = await classifyCommand(command(), { worktreePath, judgment: judgment(runtime) });
      expect(result.category).toBeNull();
    }
  });

  test("an uncertain none is marked for calibration and a confident none is not", async () => {
    const uncertain = double(() => noneVerdict(`${COMMAND_UNCERTAIN_NONE_REASON} (0.5)`));
    expect(await classifyCommand(command(), { worktreePath, judgment: judgment(uncertain.runtime) })).toEqual({
      category: null,
      source: null,
      uncertainNone: true,
    });
    const confident = double(() => noneVerdict());
    expect(await classifyCommand(command(), { worktreePath, judgment: judgment(confident.runtime) })).toEqual({
      category: null,
      source: null,
      uncertainNone: false,
    });
  });

  test("a judgment that throws is unavailable, not a failure", async () => {
    const { runtime } = double(() => { throw new Error("boom"); });
    const result = await classifyCommand(command(), { worktreePath, judgment: judgment(runtime) });
    expect(result.category).toBeNull();
  });

  test("disabled judgment does nothing", async () => {
    const inert = createInertJudgmentRuntime();
    const result = await classifyCommand(command(), { worktreePath, judgment: judgment(inert) });
    expect(result.category).toBeNull();

    const disabledDouble = double(() => enforced("destructive"));
    (disabledDouble.runtime as { enabled: boolean }).enabled = false;
    await classifyCommand(command(), { worktreePath, judgment: judgment(disabledDouble.runtime) });
    expect(disabledDouble.calls).toHaveLength(0);
  });
});

describe("command classifier: read-only commands", () => {
  test("the read-only profile and read-only git subcommands are not sent", async () => {
    const { runtime, calls } = double(() => enforced("destructive"));
    for (const request of [
      command({ profile: "git-readonly", executable: "git", args: ["status"] }),
      command({ profile: "git-readonly", executable: "git", args: ["diff", "--stat"] }),
      command({ profile: "verification", executable: "git", args: ["log", "-1"] }),
      command({ profile: "verification", executable: "GIT.exe", args: ["show", "HEAD"] }),
    ]) {
      const result = await classifyCommand(request, { worktreePath, judgment: judgment(runtime) });
      expect(result.category).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  test("a mutating git subcommand outside the read-only list is still judged", async () => {
    const { runtime, calls } = double(() => noneVerdict());
    await classifyCommand(command({ executable: "git", args: ["commit", "-m", "x"] }), {
      worktreePath,
      judgment: judgment(runtime),
    });
    expect(calls).toHaveLength(1);
  });
});

describe("command classifier: latency", () => {
  test("the deadline is at most 1.5 seconds", () => {
    expect(COMMAND_JUDGMENT_DEADLINE_MS).toBeLessThanOrEqual(1_500);
  });

  test("a slow judgment yields to the deadline and the command proceeds", async () => {
    const { runtime, calls } = double(() => new Promise(() => {}));
    const started = performance.now();
    const result = await classifyCommand(command(), {
      worktreePath,
      judgment: { ...judgment(runtime), deadlineMs: 40 },
    });
    expect(result.category).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
    expect(calls[0]!.deadlineMs).toBe(40);
  });

  test("a requested deadline can shorten the deadline but never lengthen it", async () => {
    const { runtime, calls } = double(() => noneVerdict());
    await classifyCommand(command(), { worktreePath, judgment: { ...judgment(runtime), deadlineMs: 60_000 } });
    expect(calls[0]!.deadlineMs).toBe(COMMAND_JUDGMENT_DEADLINE_MS);
  });

  test("an identical command sends one request, in sequence or at once", async () => {
    const sequential = double(() => noneVerdict());
    for (let count = 0; count < 3; count += 1) {
      await classifyCommand(command(), { worktreePath, judgment: judgment(sequential.runtime) });
    }
    expect(sequential.calls).toHaveLength(1);

    const concurrent = double(async () => enforced("external_side_effect"));
    const results = await Promise.all(
      [0, 1, 2].map(() => classifyCommand(command(), { worktreePath, judgment: judgment(concurrent.runtime) })),
    );
    expect(concurrent.calls).toHaveLength(1);
    expect(results.every((result) => result.category === "external_side_effect")).toBeTrue();
  });

  test("a different profile, executable, arguments, or working directory is a different command", async () => {
    const { runtime, calls } = double(() => noneVerdict());
    for (const request of [
      command(),
      command({ profile: "other" }),
      command({ executable: "bun" }),
      command({ args: ["run", "test"] }),
      command({ cwd: resolve(worktreePath, "sub") }),
    ]) {
      await classifyCommand(request, { worktreePath, judgment: judgment(runtime) });
    }
    expect(calls).toHaveLength(5);
  });

  test("the executable's case does not make a command different", async () => {
    const { runtime, calls } = double(() => noneVerdict());
    await classifyCommand(command({ executable: "NPM" }), { worktreePath, judgment: judgment(runtime) });
    await classifyCommand(command({ executable: "npm" }), { worktreePath, judgment: judgment(runtime) });
    expect(calls).toHaveLength(1);
  });

  test("an unavailable result is retried on the next command", async () => {
    const { runtime, calls } = double((call) =>
      call === 1 ? { kind: "fallback", reason: "network", recordId: null } : enforced("destructive"));
    const first = await classifyCommand(command(), { worktreePath, judgment: judgment(runtime) });
    const second = await classifyCommand(command(), { worktreePath, judgment: judgment(runtime) });
    expect(first.category).toBeNull();
    expect(second.category).toBe("destructive");
    expect(calls).toHaveLength(2);
  });

  test("the cache is bounded and belongs to its runtime", async () => {
    const one = double(() => noneVerdict());
    for (let index = 0; index < COMMAND_JUDGMENT_CACHE_SIZE + 5; index += 1) {
      await classifyCommand(command({ args: ["run", `script-${index}`] }), { worktreePath, judgment: judgment(one.runtime) });
    }
    // The oldest entry was dropped, so it is judged again; the newest is still held.
    await classifyCommand(command({ args: ["run", "script-0"] }), { worktreePath, judgment: judgment(one.runtime) });
    expect(one.calls).toHaveLength(COMMAND_JUDGMENT_CACHE_SIZE + 6);
    await classifyCommand(command({ args: ["run", `script-${COMMAND_JUDGMENT_CACHE_SIZE + 4}`] }), {
      worktreePath,
      judgment: judgment(one.runtime),
    });
    expect(one.calls).toHaveLength(COMMAND_JUDGMENT_CACHE_SIZE + 6);

    const other = double(() => noneVerdict());
    await classifyCommand(command(), { worktreePath, judgment: judgment(other.runtime) });
    expect(other.calls).toHaveLength(1);
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("command classifier: the state that leaves the machine", () => {
  test("holds only the command shape, with a credential flag's value replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "command-approval-"));
    directories.push(root);
    const sent: JudgmentClientRequest[] = [];
    const client: JudgmentClient = {
      async request(request) {
        sent.push(request);
        return {
          available: true,
          answers: { [COMMAND_QUESTION_IDS.category]: { type: "choice", choice: "none", probabilities: { none: 0.95 }, confidence: 0.95 } },
          model: "jev-1.13.0",
          inputTokens: 100,
          outputTokens: 0,
          durationMs: 5,
        };
      },
    };
    const runtime = createJudgmentRuntime({
      env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "sk-test-key-do-not-leak", MUSTER_JEV_MODE: "enforce" },
      store: new AtomicJsonStore(root),
      client,
    });
    process.env.COMMAND_APPROVAL_TEST_SECRET = "must-not-appear";
    try {
      await classifyCommand(
        command({
          args: ["run", "release", "--token", "npm_supersecret", "--password=hunter2", "--api-key", "abc123"],
          cwd: resolve(worktreePath, "packages/app"),
          timeoutMs: 5_000,
        }),
        { worktreePath, judgment: judgment(runtime) },
      );
    } finally {
      delete process.env.COMMAND_APPROVAL_TEST_SECRET;
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.state).toEqual({
      executable: "npm",
      args: ["run", "release", "--token", "[REDACTED]", "--password=[REDACTED]", "--api-key", "[REDACTED]"],
      cwd: "packages/app",
      profile: "verification",
    });
    const text = JSON.stringify(sent[0]);
    for (const leaked of ["npm_supersecret", "hunter2", "abc123", "must-not-appear", "/work/tree"]) {
      expect(text).not.toContain(leaked);
    }
  });

  test("a working directory outside the worktree is named without its path", async () => {
    const { runtime, calls } = double(() => noneVerdict());
    await classifyCommand(command({ cwd: "/somewhere/else" }), { worktreePath, judgment: judgment(runtime) });
    expect((calls[0]!.state as { cwd: string }).cwd).toBe("<outside worktree>");
  });

  test("the worktree root is sent as a dot", async () => {
    const { runtime, calls } = double(() => noneVerdict());
    await classifyCommand(command(), { worktreePath, judgment: judgment(runtime) });
    expect((calls[0]!.state as { cwd: string }).cwd).toBe(".");
  });
});
