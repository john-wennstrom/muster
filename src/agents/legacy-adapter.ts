import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  validateCollaborationPlan,
  type CollaborationTask,
} from "../../extensions/fusion-harness/modules/collaboration-graph.ts";
import { GitAdapter } from "../execution/git.ts";
import {
  acquireWriterLease,
  type AcquireWriterLeaseOptions,
  type WriterLease,
  type WriterLeaseRecord,
} from "../execution/writer-lease.ts";
import {
  authorizeToolRequest,
  type AgentRole,
  type AuthorizationContext,
} from "../tools/authorization.ts";
import {
  runAuditedHostCommand,
  type StructuredCommandRequest,
} from "../tools/host-runner.ts";
import type { BrokerRequestContext } from "./child-runner.ts";
import {
  runBrokeredChild,
  type BrokerChildRole,
  type RunBrokeredChildOptions,
} from "./child-runner.ts";
import { createFreshRoleSession } from "./role-runner.ts";

export interface LegacyTaskBrokerOptions {
  cwd: string;
  runId: string;
  childId: string;
  role: AgentRole;
  task: CollaborationTask;
  lease?: Pick<
    AcquireWriterLeaseOptions,
    "lockDirectory" | "processAlive" | "reconcileStaleOwner" | "now"
  >;
  existingWriterLease?: WriterLeaseRecord;
  persistEvidence?: (
    tool: "submit_gate" | "submit_scope",
    input: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
}

export interface LegacyTaskBroker {
  repositoryId: string;
  worktreePath: string;
  writerLease: WriterLeaseRecord | null;
  handleRequest(request: BrokerRequestContext): Promise<unknown>;
  close(): Promise<void>;
}

export interface RunLegacyBrokeredChildOptions extends Omit<
  RunBrokeredChildOptions,
  "handleRequest" | "taskId" | "writeEnabled"
> {
  onAgentStart?: (run: RunBrokeredChildOptions["run"]) => void;
  task: CollaborationTask;
  lease?: LegacyTaskBrokerOptions["lease"];
  existingWriterLease?: WriterLeaseRecord;
  persistEvidence?: LegacyTaskBrokerOptions["persistEvidence"];
  continueTaskSession?: boolean;
}

export interface RunLegacyScopePlannerOptions extends Omit<
  RunLegacyBrokeredChildOptions,
  "persistEvidence" | "prompt" | "role" | "task"
> {
  description: string;
  plannedTaskId: string;
  plannedAssignee: string;
}

export interface RunLegacyReadOnlyChildOptions extends Omit<
  RunLegacyBrokeredChildOptions,
  "lease" | "persistEvidence" | "task"
> {
  taskId: string;
  description: string;
  assignee: string;
  readScopes?: readonly string[];
}

export interface LegacyScopePlan {
  reads: string[];
  writes: string[];
}

export type LegacyScopePlanner = (prompt: string) => Promise<unknown>;

export function legacyScopePlanningPrompt(description: string): string {
  return [
    "Plan the minimum repository scopes needed for this legacy writer.",
    "Call muster_submit_scope exactly once with string arrays reads and writes.",
    "Use repository-relative paths or narrow /** globs. Never use writes:[\"**\"].",
    `Task: ${description}`,
  ].join("\n");
}

export function validateLegacyScopePlan(input: unknown): LegacyScopePlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Legacy scope plan must be a JSON object");
  }
  const value = input as Record<string, unknown>;
  const unknownFields = Object.keys(value).filter((field) => field !== "reads" && field !== "writes");
  if (unknownFields.length > 0) throw new Error(`Legacy scope plan has unknown fields: ${unknownFields.join(", ")}`);
  const task = validateCollaborationPlan({
    tasks: [{
      id: "1.scope",
      assignee: "scope-planner",
      description: "legacy scope plan",
      depends_on: [],
      outputs: [],
      mode: "write",
      reads: value.reads,
      writes: value.writes,
    }],
  }, ["scope-planner"]).tasks[0]!;
  return { reads: task.reads, writes: task.writes };
}

export async function planLegacyWriteTask(
  task: Omit<CollaborationTask, "reads" | "writes">,
  planner: LegacyScopePlanner,
): Promise<CollaborationTask> {
  const plan = validateLegacyScopePlan(await planner(legacyScopePlanningPrompt(task.description)));
  return { ...task, mode: "write", ...plan };
}

function requestObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Broker tool input must be an object");
  }
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Broker tool input requires ${field}`);
  return value;
}

async function searchFiles(root: string, query: string, limit = 200): Promise<string[]> {
  const results: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (results.length >= limit) return;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && !entry.isSymbolicLink()) await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let contents: string;
      try {
        contents = await readFile(path, "utf8");
      } catch {
        continue;
      }
      for (const [index, line] of contents.split(/\r?\n/).entries()) {
        if (line.includes(query)) results.push(`${relative(root, path).split(sep).join("/")}:${index + 1}:${line}`);
        if (results.length >= limit) return;
      }
    }
  };
  await visit(root);
  return results;
}

export async function createLegacyTaskBroker(
  options: LegacyTaskBrokerOptions,
): Promise<LegacyTaskBroker> {
  const identity = await new GitAdapter(options.cwd).identity();
  const worktreePath = identity.root;
  let lease: WriterLease | null = null;
  let writerLease = options.existingWriterLease ?? null;
  if (options.task.mode === "write") {
    if (writerLease) {
      if (
        writerLease.repositoryId !== identity.id ||
        resolve(writerLease.worktreePath) !== resolve(worktreePath) ||
        writerLease.runId !== options.runId ||
        writerLease.taskId !== options.task.id
      ) {
        throw new Error(`Existing writer lease does not belong to task ${options.task.id}`);
      }
    } else {
      lease = await acquireWriterLease({
        identity: {
          repositoryId: identity.id,
          worktreePath,
          runId: options.runId,
          taskId: options.task.id,
          command: `legacy:${options.role}`,
        },
        ...options.lease,
      });
      writerLease = lease.record;
    }
  }
  const authorization: AuthorizationContext = {
    role: options.role,
    runId: options.runId,
    childId: options.childId,
    taskId: options.task.id,
    taskState: "running",
    repositoryId: identity.id,
    worktreePath,
    readScopes: options.task.reads,
    writeScopes: options.task.writes,
    writerLease,
  };

  return {
    repositoryId: identity.id,
    worktreePath,
    writerLease,
    async handleRequest(request) {
      const input = requestObject(request.input);
      const targetPath = request.tool === "command"
        ? requiredString(input, "cwd")
        : typeof input.path === "string" && input.path.trim()
          ? input.path
          : ".";
      const decision = await authorizeToolRequest(authorization, {
        tool: request.tool,
        targetPath,
        correlationId: request.correlationId,
        requestBytes: Buffer.byteLength(JSON.stringify(request.input)),
      });
      if (!decision.allowed) throw new Error(decision.reason);
      if (request.tool === "submit_gate" || request.tool === "submit_scope") {
        if (!options.persistEvidence) throw new Error("No parent evidence persistence handler is configured");
        return options.persistEvidence("submit_gate", input);
      }
      if (!decision.canonicalPath) throw new Error("Authorized filesystem tool has no canonical path");

      if (request.tool === "read_file") return readFile(decision.canonicalPath, "utf8");
      if (request.tool === "search") {
        return searchFiles(decision.canonicalPath, requiredString(input, "query"));
      }
      if (request.tool === "write_file") {
        const content = requiredString(input, "content");
        await mkdir(dirname(decision.canonicalPath), { recursive: true });
        await writeFile(decision.canonicalPath, content);
        return { path: relative(worktreePath, decision.canonicalPath).split(sep).join("/"), written: true };
      }
      if (request.tool === "command") {
        const command: StructuredCommandRequest = {
          profile: requiredString(input, "profile"),
          executable: requiredString(input, "executable"),
          args: Array.isArray(input.args) && input.args.every((value) => typeof value === "string")
            ? input.args
            : (() => { throw new Error("Broker command input requires string args"); })(),
          cwd: decision.canonicalPath,
        };
        const result = await runAuditedHostCommand({
          worktreePath,
          request: command,
          allowedWriteScopes: options.task.writes,
          signal: request.signal,
        });
        if (!result.acceptedAsEvidence) {
          throw new Error(result.audit.violations.join("; ") || `Command exited with ${result.process.exitCode}`);
        }
        return result;
      }
      throw new Error(`Unsupported broker tool ${request.tool}`);
    },
    async close() {
      await lease?.release();
      lease = null;
    },
  };
}

export async function runLegacyBrokeredChild(
  options: RunLegacyBrokeredChildOptions,
) {
  options.onAgentStart?.(options.run);
  const broker = await createLegacyTaskBroker({
    cwd: options.cwd,
    runId: options.runId,
    childId: options.childId,
    role: options.role,
    task: options.task,
    lease: options.lease,
    existingWriterLease: options.existingWriterLease,
    persistEvidence: options.persistEvidence,
  });
  try {
    const freshSession = createFreshRoleSession(
      options.sessionDir,
      options.runId,
      options.task.id,
      options.role,
    );
    const session = options.continueTaskSession
      ? { sessionDir: options.sessionDir, sessionId: options.sessionId, resume: options.resume, fork: options.fork }
      : freshSession;
    return await runBrokeredChild({
      ...options,
      ...session,
      fork: options.continueTaskSession ? options.fork : undefined,
      resume: options.continueTaskSession ? options.resume : undefined,
      taskId: options.task.id,
      writeEnabled: options.task.mode === "write",
      handleRequest: broker.handleRequest,
    });
  } finally {
    await broker.close();
  }
}

export async function runLegacyScopePlannerChild(
  options: RunLegacyScopePlannerOptions,
): Promise<{ run: Awaited<ReturnType<typeof runBrokeredChild>>; task: CollaborationTask }> {
  let scopes: LegacyScopePlan | undefined;
  const planningTask: CollaborationTask = {
    id: `${options.plannedTaskId}.scope`,
    assignee: options.plannedAssignee,
    description: `Plan scopes for ${options.description}`,
    depends_on: [],
    outputs: [],
    mode: "read",
    reads: ["**"],
    writes: [],
  };
  const run = await runLegacyBrokeredChild({
    ...options,
    prompt: legacyScopePlanningPrompt(options.description),
    role: "architect",
    task: planningTask,
    persistEvidence: async (tool, input) => {
      if (tool !== "submit_scope") throw new Error("Scope planner submitted unsupported evidence");
      scopes = validateLegacyScopePlan(input);
      return { accepted: true, scopes };
    },
  });
  if (!scopes) throw new Error("Legacy scope planner did not submit a valid scope plan");
  return {
    run,
    task: {
      id: options.plannedTaskId,
      assignee: options.plannedAssignee,
      description: options.description,
      depends_on: [],
      outputs: [],
      mode: "write",
      reads: scopes.reads,
      writes: scopes.writes,
    },
  };
}

export function runLegacyReadOnlyChild(options: RunLegacyReadOnlyChildOptions) {
  return runLegacyBrokeredChild({
    ...options,
    task: {
      id: options.taskId,
      assignee: options.assignee,
      description: options.description,
      depends_on: [],
      outputs: [],
      mode: "read",
      reads: [...(options.readScopes ?? ["**"])],
      writes: [],
    },
  });
}
