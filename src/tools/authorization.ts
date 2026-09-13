import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WriterLeaseRecord } from "../execution/writer-lease.ts";
import type { BrokerAuditEvent } from "./protocol.ts";

export type AgentRole = "architect" | "builder" | "reviewer" | "validator";
export type AuthorizedTaskState = "ready" | "running" | "completed" | "blocked" | "awaiting_user";
export type ToolCapability = "read" | "write" | "command" | "evidence" | "prohibited";

const TOOL_CAPABILITIES: Readonly<Record<string, ToolCapability>> = {
  read_file: "read",
  search: "read",
  list_files: "read",
  serena_read: "read",
  apply_patch: "write",
  write_file: "write",
  serena_write: "write",
  command: "command",
  submit_gate: "evidence",
  submit_scope: "evidence",
  shell: "prohibited",
};

export interface AuthorizationRequest {
  tool: string;
  targetPath: string;
  correlationId: string;
  requestBytes: number;
}

export interface AuthorizationContext {
  role: AgentRole;
  runId: string;
  childId: string;
  taskId: string;
  taskState: AuthorizedTaskState;
  repositoryId: string;
  worktreePath: string;
  readScopes: readonly string[];
  writeScopes: readonly string[];
  writerLease?: WriterLeaseRecord | null;
  now?: () => Date;
}

export interface AuthorizationDecision {
  allowed: boolean;
  capability: ToolCapability | null;
  canonicalPath: string | null;
  reason: string;
  audit: BrokerAuditEvent;
}

class PathAuthorizationError extends Error {}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

async function canonicalTarget(worktreePath: string, targetPath: string): Promise<{
  root: string;
  path: string;
  relativePath: string;
}> {
  const root = await realpath(worktreePath);
  const lexicalTarget = isAbsolute(targetPath) ? resolve(targetPath) : resolve(root, targetPath);
  if (!isInside(root, lexicalTarget)) throw new PathAuthorizationError("target path escapes the worktree");
  const segments = relative(root, lexicalTarget).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = resolve(current, ...segments.slice(index));
      break;
    }
    const exact = entries.find((entry) => entry === segment);
    if (!exact) {
      const caseAlias = entries.find((entry) => entry.toLocaleLowerCase() === segment.toLocaleLowerCase());
      if (caseAlias) {
        throw new PathAuthorizationError(`target path casing differs from ${caseAlias}`);
      }
      current = resolve(current, ...segments.slice(index));
      break;
    }
    current = await realpath(resolve(current, exact));
    if (!isInside(root, current)) throw new PathAuthorizationError("target path resolves outside the worktree");
  }
  if (!isInside(root, current)) throw new PathAuthorizationError("target path resolves outside the worktree");
  return {
    root,
    path: current,
    relativePath: relative(root, current).split(sep).join("/"),
  };
}

function scopeMatches(path: string, scope: string): boolean {
  const normalized = scope.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (normalized === "**") return true;
  if (normalized.endsWith("/**")) {
    const root = normalized.slice(0, -3);
    return path === root || path.startsWith(`${root}/`);
  }
  return path === normalized;
}

function leaseMatches(context: AuthorizationContext, root: string): boolean {
  const lease = context.writerLease;
  return Boolean(
    lease &&
    lease.repositoryId === context.repositoryId &&
    lease.worktreePath === root &&
    lease.runId === context.runId &&
    lease.taskId === context.taskId,
  );
}

function audit(
  context: AuthorizationContext,
  request: AuthorizationRequest,
  decision: "allow" | "deny",
  reason: string,
): BrokerAuditEvent {
  return {
    schemaVersion: 1,
    timestamp: (context.now ?? (() => new Date()))().toISOString(),
    runId: context.runId,
    childId: context.childId,
    taskId: context.taskId,
    correlationId: request.correlationId,
    tool: request.tool,
    decision,
    reason,
    requestBytes: request.requestBytes,
  };
}

function denied(
  context: AuthorizationContext,
  request: AuthorizationRequest,
  capability: ToolCapability | null,
  reason: string,
  canonicalPath: string | null = null,
): AuthorizationDecision {
  return {
    allowed: false,
    capability,
    canonicalPath,
    reason,
    audit: audit(context, request, "deny", reason),
  };
}

export async function authorizeToolRequest(
  context: AuthorizationContext,
  request: AuthorizationRequest,
): Promise<AuthorizationDecision> {
  const capability = TOOL_CAPABILITIES[request.tool] ?? null;
  if (!capability) return denied(context, request, null, `unknown tool ${request.tool}`);
  if (capability === "prohibited") return denied(context, request, capability, "direct shell access is prohibited");
  if (capability === "evidence") {
    const roleAllowed = request.tool === "submit_gate"
      ? context.role === "validator"
      : request.tool === "submit_scope" && context.role === "architect";
    if (!roleAllowed || context.taskState !== "running") {
      return denied(context, request, capability, `${request.tool} requires its running evidence role`);
    }
    const reason = `${request.tool} evidence submission is authorized`;
    return {
      allowed: true,
      capability,
      canonicalPath: null,
      reason,
      audit: audit(context, request, "allow", reason),
    };
  }
  if ((context.role === "reviewer" || context.role === "validator") && capability !== "read") {
    return denied(context, request, capability, `${context.role} role is read-only`);
  }

  let target: Awaited<ReturnType<typeof canonicalTarget>>;
  try {
    target = await canonicalTarget(context.worktreePath, request.targetPath);
  } catch (error) {
    return denied(
      context,
      request,
      capability,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (capability === "read") {
    if (!context.readScopes.some((scope) => scopeMatches(target.relativePath, scope))) {
      return denied(context, request, capability, "target path is outside declared read scopes", target.path);
    }
  } else {
    if (context.taskState !== "running") {
      return denied(context, request, capability, "write capability requires a running task", target.path);
    }
    if (!leaseMatches(context, target.root)) {
      return denied(context, request, capability, "write capability requires the matching active writer lease", target.path);
    }
    if (
      capability === "write" &&
      !context.writeScopes.some((scope) => scopeMatches(target.relativePath, scope))
    ) {
      return denied(context, request, capability, "target path is outside declared write scopes", target.path);
    }
  }

  const reason = `${capability} tool is authorized`;
  return {
    allowed: true,
    capability,
    canonicalPath: target.path,
    reason,
    audit: audit(context, request, "allow", reason),
  };
}