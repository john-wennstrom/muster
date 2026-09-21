import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { CollaborationTask } from "../execution/collaboration-task.ts";
import { GitAdapter } from "../execution/git.ts";
import {
  acquireWriterLease,
  type AcquireWriterLeaseOptions,
  type WriterLease,
  type WriterLeaseRecord,
} from "../execution/writer-lease.ts";
import { runProcess } from "../shared/process.ts";
import {
  authorizeToolRequest,
  type AgentRole,
  type AuthorizationContext,
} from "../tools/authorization.ts";
import type { CommandJudgmentOptions } from "../tools/command-approval.ts";
import {
  runAuditedHostCommand,
  type StructuredCommandRequest,
} from "../tools/host-runner.ts";
import type { BrokerRequestContext } from "./broker-server.ts";

export interface TaskBrokerOptions {
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
  /** Adds judged manual-approval categories to the brokered commands' rule checks. */
  judgment?: CommandJudgmentOptions;
}

export interface TaskBroker {
  repositoryId: string;
  worktreePath: string;
  writerLease: WriterLeaseRecord | null;
  handleRequest(request: BrokerRequestContext): Promise<unknown>;
  close(): Promise<void>;
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

async function searchFiles(
  root: string,
  query: string,
  authorization: AuthorizationContext,
  request: BrokerRequestContext,
  limit = 200,
): Promise<string[]> {
  // Enumerate source files through Git so ignored dependency/cache trees are never walked.
  // Literal pathspecs prevent a filename from changing the search scope.
  const listing = await runProcess("git", [
    "--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
    relative(authorization.worktreePath, root).split(sep).join("/") || ".",
  ], { cwd: authorization.worktreePath, signal: request.signal, timeoutMs: 30_000 });
  if (listing.exitCode !== 0) throw new Error(`Cannot list searchable files: ${listing.stderr}`);
  const results: string[] = [];
  for (const path of new Set(listing.stdout.split("\0").filter(Boolean))) {
    request.signal.throwIfAborted();
    if (path.split("/").some((segment) => [".git", ".fusion", "node_modules"].includes(segment))) continue;
    const decision = await authorizeToolRequest(authorization, {
      tool: "read_file", targetPath: path, correlationId: request.correlationId, requestBytes: 0,
    });
    if (!decision.allowed || !decision.canonicalPath) continue;
    let contents: string;
    try {
      const stat = await lstat(decision.canonicalPath);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      contents = await readFile(decision.canonicalPath, { encoding: "utf8", signal: request.signal });
    } catch (error) {
      request.signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (contents.includes("\0")) continue;
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      if (line.includes(query)) results.push(`${path}:${index + 1}:${line.slice(0, 1000)}`);
      if (results.length >= limit) return results;
    }
  }
  return results;
}

export async function createTaskBroker(
  options: TaskBrokerOptions,
): Promise<TaskBroker> {
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
          command: `agent:${options.role}`,
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
        return options.persistEvidence(request.tool, input);
      }
      if (!decision.canonicalPath) throw new Error("Authorized filesystem tool has no canonical path");

      if (request.tool === "read_file") return readFile(decision.canonicalPath, "utf8");
      if (request.tool === "search") {
        return searchFiles(decision.canonicalPath, requiredString(input, "query"), authorization, request);
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
          judgment: options.judgment ? { signal: request.signal, ...options.judgment } : undefined,
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
