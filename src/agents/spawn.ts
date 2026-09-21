/**
 * spawn.ts — the one place a model child process is started.
 *
 * `runAgent` runs one child in read mode (exploration, planning, reviews) or write mode (a
 * builder task with its declared scopes, writer lease and judgment hook). It owns the
 * `pi --mode json -p` invocation, the broker server that answers a child's brokered tools, and
 * the tool sets each mode gets. Nothing else under src/ starts a child: the process itself is
 * launched by pi-process.ts, which only this module calls.
 */

import { fileURLToPath } from "node:url";
import { HarnessError } from "../shared/errors.ts";
import type { CollaborationTask } from "../execution/collaboration-task.ts";
import type { WriterLeaseRecord } from "../execution/writer-lease.ts";
import type { CommandJudgmentOptions } from "../tools/command-approval.ts";
import {
  startChildBrokerServer,
  type BrokerChildRole,
  type ChildBrokerServer,
} from "./broker-server.ts";
import { resolveChildRuntime, type ChildAccess, type ResolvedChildRuntime } from "./child-runtime.ts";
import type { ModelStack } from "./model-stack.ts";
import { createFreshRoleSession } from "./role-runner.ts";
import { runOk, type AgentRun } from "./run-record.ts";
import { runPiProcess, type Thinking } from "./pi-process.ts";
import { createTaskBroker, type TaskBroker, type TaskBrokerOptions } from "./task-broker.ts";
import { isRenderedPrompt, renderPrompt, type RenderedPrompt } from "../prompts/render.ts";

export type { Thinking } from "./pi-process.ts";

const CHILD_BROKER_EXTENSION = fileURLToPath(new URL("./child-broker.ts", import.meta.url));

export function brokeredToolNames(
  role: BrokerChildRole,
  writeEnabled = role === "builder",
  evidenceEnabled = false,
): string[] {
  const tools = ["muster_read", "muster_search"];
  if (evidenceEnabled && role === "architect") tools.push("muster_submit_scope");
  if (evidenceEnabled && role === "validator") tools.push("muster_submit_gate");
  if (writeEnabled && role !== "reviewer" && role !== "validator") {
    tools.push("muster_write", "muster_command");
  }
  return tools;
}

export function brokeredChildRuntime(
  role: BrokerChildRole,
  writeEnabled = role === "builder",
  evidenceEnabled = false,
): ResolvedChildRuntime {
  return {
    extensions: [CHILD_BROKER_EXTENSION],
    tools: brokeredToolNames(role, writeEnabled, evidenceEnabled),
  };
}

function accessForRole(role: BrokerChildRole, writeEnabled = role === "builder"): ChildAccess {
  if (role === "reviewer") return "read";
  if (role === "validator") return "validator";
  return writeEnabled ? "write" : "read";
}

interface StandardRuntimeOptions {
  role: BrokerChildRole;
  evidenceEnabled?: boolean;
  writeEnabled?: boolean;
  run: AgentRun;
  modelStack?: Pick<ModelStack, "child">;
}

export function standardChildRuntime(options: StandardRuntimeOptions): ResolvedChildRuntime {
  const runtime = resolveChildRuntime(
    options.modelStack ?? {}, options.run.slot ?? {}, accessForRole(options.role, options.writeEnabled),
  );
  const evidenceTools = !options.evidenceEnabled ? []
    : options.role === "architect" ? ["muster_submit_scope"]
    : options.role === "validator" ? ["muster_submit_gate"] : [];
  return {
    extensions: [...new Set([...runtime.extensions, ...(evidenceTools.length ? [CHILD_BROKER_EXTENSION] : [])])],
    tools: [...new Set([...runtime.tools, ...evidenceTools])],
  };
}

interface AgentOptionsBase {
  run: AgentRun;
  modelStack?: Pick<ModelStack, "child">;
  onAgentStart?: (run: AgentRun) => void;
  /** Text from a template file; a string built by hand is rejected. */
  prompt: RenderedPrompt;
  systemPrompt?: string;
  appendSystemPrompts?: string[];
  role: BrokerChildRole;
  runId: string;
  childId: string;
  thinking: Thinking;
  sessionDir: string;
  sessionId?: string;
  fork?: string;
  resume?: string;
  /** Keep the session identity given here instead of starting a fresh session under `sessionDir`. */
  continueTaskSession?: boolean;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Standard Pi tools are the default; brokered filesystem tools are opt-in. */
  toolMode?: "standard" | "brokered";
  maxRequests?: number;
}

/** A child that only reads: exploration, planning and every review. */
export interface ReadAgentOptions extends AgentOptionsBase {
  access: "read";
  taskId: string;
  description: string;
  assignee: string;
  readScopes?: readonly string[];
}

/** A child that runs a task: its declared scopes, its writer lease and its judgment hook. */
export interface WriteAgentOptions extends AgentOptionsBase {
  access: "write";
  task: CollaborationTask;
  lease?: TaskBrokerOptions["lease"];
  existingWriterLease?: WriterLeaseRecord;
  persistEvidence?: TaskBrokerOptions["persistEvidence"];
  judgment?: CommandJudgmentOptions;
}

export type RunAgentOptions = ReadAgentOptions | WriteAgentOptions;

/** The shape callers accept where tests substitute the real child process. */
export type ReadAgentRunner = (options: ReadAgentOptions) => Promise<AgentRun>;
export type WriteAgentRunner = (options: WriteAgentOptions) => Promise<AgentRun>;

/** The scope reminder appended to every agent's prompt. */
export function taskScopeNotice(task: Pick<CollaborationTask, "mode" | "reads" | "writes">): RenderedPrompt {
  return renderPrompt(task.mode === "read" ? "scope-read" : "scope-write", {
    READ_SCOPES: JSON.stringify(task.reads),
    WRITE_SCOPES: JSON.stringify(task.writes),
  });
}

function readTask(options: ReadAgentOptions): CollaborationTask {
  return {
    id: options.taskId,
    assignee: options.assignee,
    description: options.description,
    depends_on: [],
    outputs: [],
    mode: "read",
    reads: [...(options.readScopes ?? ["**"])],
    writes: [],
  };
}

/** Run one child agent to completion and return its settled run record. */
export async function runAgent(options: RunAgentOptions): Promise<AgentRun> {
  if (!isRenderedPrompt(options.prompt)) {
    throw new HarnessError("PROMPT_TEMPLATE_INVALID", "runAgent accepts only a prompt rendered from a template file", {
      childId: options.childId,
    });
  }
  options.onAgentStart?.(options.run);
  const write = options.access === "write" ? options : undefined;
  const task = write ? write.task : readTask(options as ReadAgentOptions);
  const writeEnabled = task.mode === "write";
  const evidenceEnabled = Boolean(write?.persistEvidence);
  const toolMode = options.toolMode ?? "standard";
  let taskBroker: TaskBroker | undefined;
  let childBroker: ChildBrokerServer | undefined;
  try {
    taskBroker = await createTaskBroker({
      cwd: options.cwd,
      runId: options.runId,
      childId: options.childId,
      role: options.role,
      task,
      lease: write?.lease,
      existingWriterLease: write?.existingWriterLease,
      persistEvidence: write?.persistEvidence,
      judgment: write?.judgment,
    });
    const session = options.continueTaskSession
      ? { sessionDir: options.sessionDir, sessionId: options.sessionId, resume: options.resume, fork: options.fork }
      : createFreshRoleSession(options.sessionDir, options.runId, task.id, options.role);
    const childRuntime = toolMode === "brokered"
      ? brokeredChildRuntime(options.role, writeEnabled, evidenceEnabled)
      : standardChildRuntime({ ...options, writeEnabled, evidenceEnabled });
    childBroker = toolMode === "brokered" || evidenceEnabled
      ? await startChildBrokerServer({
        runId: options.runId,
        childId: options.childId,
        taskId: task.id,
        handleRequest: taskBroker.handleRequest,
        maxRequests: options.maxRequests,
      })
      : undefined;
    return await runPiProcess({
      run: options.run,
      prompt: `${options.prompt}\n\n${taskScopeNotice(task)}`,
      systemPrompt: options.systemPrompt,
      appendSystemPrompts: options.appendSystemPrompts,
      access: accessForRole(options.role, writeEnabled),
      childRuntime,
      thinking: options.thinking,
      ...session,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      environment: {
        ...childBroker?.environment,
        MUSTER_TOOL_MODE: toolMode,
        MUSTER_BROKER_ROLE: options.role,
        MUSTER_BROKER_WRITE_ENABLED: writeEnabled ? "1" : "0",
      },
    });
  } catch (error) {
    options.run.status = options.signal?.aborted ? "aborted" : "failed";
    options.run.errorMessage = error instanceof Error ? error.message : String(error);
    options.run.exitCode = options.signal?.aborted ? 130 : 1;
    options.run.endedAt = Date.now();
    throw error;
  } finally {
    await childBroker?.close();
    await taskBroker?.close();
  }
}
