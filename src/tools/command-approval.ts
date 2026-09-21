import { isAbsolute, relative, sep } from "node:path";
import type { JudgmentRuntime } from "../judgment/ask.ts";
import { REDACTED } from "../judgment/egress.ts";
import { commandClassificationDecision, commandState, isUncertainNone, type CommandClassificationInput, type CommandGateValue } from "../judgment/decisions/command-classification.ts";
import { canonicalize } from "../judgment/questions.ts";
import { tryJudge } from "../judgment/try.ts";
import {
  classifyProhibitedCommand,
  READ_ONLY_GIT_COMMANDS,
  type ManualCommandCategory,
  type StructuredCommandRequest,
} from "./host-runner.ts";

/**
 * Which manual-approval category, if any, a host command belongs to. The rule classifier runs
 * first and is never bypassed: judgment is consulted only for a command the rules return
 * nothing for, and can only add a category. A judged none, an unavailable judgment, a
 * disabled judgment, and a shadow-mode judgment all leave the command exactly as it is without
 * judgment. Both enforcement points, the audited host runner and the controller's runtime
 * guard, call `classifyCommand`, so the ordering and the tagging live in one place.
 */

/** The longest a command waits for judgment before it proceeds as it does without it. */
export const COMMAND_JUDGMENT_DEADLINE_MS = 1_500;

/** Classifications kept per runtime; the oldest is dropped first. */
export const COMMAND_JUDGMENT_CACHE_SIZE = 256;

/** Profiles that cannot mutate anything, so judging their commands could only add latency. */
const READ_ONLY_PROFILES: ReadonlySet<string> = new Set(["git-readonly"]);

export interface CommandJudgmentOptions {
  readonly runtime: JudgmentRuntime;
  readonly changeName: string;
  readonly taskId?: string;
  readonly signal?: AbortSignal;
  /** Shortens the deadline; it is never longer than `COMMAND_JUDGMENT_DEADLINE_MS`. */
  readonly deadlineMs?: number;
}

export interface ClassifyCommandOptions {
  /** The worktree the command's working directory is made relative to before it is sent. */
  readonly worktreePath: string;
  readonly judgment?: CommandJudgmentOptions;
}

export type CommandClassification =
  | { readonly category: ManualCommandCategory; readonly source: "rule" }
  | {
      readonly category: ManualCommandCategory;
      readonly source: "judgment";
      readonly confidence: number;
      readonly recordId: string | null;
    }
  /** Nothing needs manual approval; `uncertainNone` marks a none the service was unsure of. */
  | { readonly category: null; readonly source: null; readonly uncertainNone: boolean };

const PROCEED: CommandClassification = { category: null, source: null, uncertainNone: false };

interface Judged {
  readonly classification: CommandClassification;
  /** Only a classification that was actually made is reused; an unavailable result is retried. */
  readonly reusable: boolean;
}

/** One cache per runtime, so it dies with the run and never crosses a decision or model change. */
const caches = new WeakMap<JudgmentRuntime, Map<string, Promise<Judged>>>();

function cacheOf(runtime: JudgmentRuntime): Map<string, Promise<Judged>> {
  let cache = caches.get(runtime);
  if (!cache) {
    cache = new Map();
    caches.set(runtime, cache);
  }
  return cache;
}

function relativeWorkingDirectory(worktreePath: string, cwd: string): string {
  const path = relative(worktreePath, cwd);
  if (path === "") return ".";
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return "<outside worktree>";
  return path.split(sep).join("/");
}

const secretFlag = /^--?(?:password|passphrase|token|api[-_]?key|secret)$/i;

/**
 * A credential flag given as its own argument keeps its value in the next one, which the
 * layer's per-string redaction cannot see, so that value is replaced here. Every other
 * argument is left for the layer's redaction of secret patterns.
 */
function redactFlagValues(args: readonly string[]): string[] {
  return args.map((argument, position) =>
    position > 0 && secretFlag.test(args[position - 1]!) ? REDACTED : argument);
}

function isReadOnly(request: StructuredCommandRequest): boolean {
  if (READ_ONLY_PROFILES.has(request.profile)) return true;
  const executable = request.executable.toLocaleLowerCase().replace(/\.exe$/, "");
  const subcommand = request.args[0]?.toLocaleLowerCase();
  return executable === "git" && subcommand !== undefined && READ_ONLY_GIT_COMMANDS.has(subcommand);
}

function cacheKey(request: StructuredCommandRequest, cwd: string): string {
  return canonicalize({
    profile: request.profile,
    executable: request.executable.toLocaleLowerCase(),
    args: [...request.args],
    cwd,
  });
}

async function judgeOnce(
  request: StructuredCommandRequest,
  cwd: string,
  judgment: CommandJudgmentOptions,
): Promise<Judged> {
  const input: CommandClassificationInput = {
    executable: request.executable,
    args: redactFlagValues(request.args),
    cwd,
    profile: request.profile,
  };
  const deadlineMs = Math.min(judgment.deadlineMs ?? COMMAND_JUDGMENT_DEADLINE_MS, COMMAND_JUDGMENT_DEADLINE_MS);
  const controller = new AbortController();
  const abort = () => controller.abort();
  judgment.signal?.addEventListener("abort", abort, { once: true });
  if (judgment.signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("deadline");
    }, deadlineMs);
  });
  try {
    const verdict = await Promise.race([
      tryJudge(judgment.runtime, commandClassificationDecision, {
        input,
        changeName: judgment.changeName,
        phase: "implementation",
        taskId: judgment.taskId,
        state: commandState(input),
        signal: controller.signal,
        deadlineMs,
      }),
      deadline,
    ]);
    if (verdict === "deadline" || verdict === null) {
      return { classification: PROCEED, reusable: false };
    }
    // Shadow mode records what would have stopped and hands nothing back to act on.
    if (verdict.kind === "shadow") return { classification: PROCEED, reusable: true };
    if (verdict.outcome.act) {
      const value: CommandGateValue = verdict.outcome.value;
      return {
        classification: {
          category: value.category,
          source: "judgment",
          confidence: value.confidence,
          recordId: verdict.recordId,
        },
        reusable: true,
      };
    }
    return {
      classification: { category: null, source: null, uncertainNone: isUncertainNone(verdict.outcome.reason) },
      reusable: true,
    };
  } finally {
    clearTimeout(timer);
    judgment.signal?.removeEventListener("abort", abort);
  }
}

export async function classifyCommand(
  request: StructuredCommandRequest,
  options: ClassifyCommandOptions,
): Promise<CommandClassification> {
  const ruled = classifyProhibitedCommand(request);
  if (ruled) return { category: ruled, source: "rule" };

  const judgment = options.judgment;
  if (!judgment?.runtime.enabled || isReadOnly(request)) return PROCEED;

  const cwd = relativeWorkingDirectory(options.worktreePath, request.cwd);
  const cache = cacheOf(judgment.runtime);
  const key = cacheKey(request, cwd);
  const earlier = cache.get(key);
  if (earlier) return (await earlier).classification;

  const pending = judgeOnce(request, cwd, judgment);
  cache.set(key, pending);
  if (cache.size > COMMAND_JUDGMENT_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  try {
    const judged = await pending;
    if (!judged.reusable) cache.delete(key);
    return judged.classification;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}
