import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  runProcess,
  type ProcessResult,
  type ProcessRunner,
} from "../shared/process.ts";
import {
  COMMAND_PROFILES,
  CommandProfileError,
  resolveCommandProfile,
  validateArguments,
  validateExecutable,
  validateTimeout,
  type CommandProfile,
} from "./command-profile.ts";
import {
  auditRepositoryCommand,
  captureRepositoryCommandSnapshot,
  type CommandScopeAudit,
  type RepositoryCommandSnapshot,
} from "./command-audit.ts";

export interface StructuredCommandRequest {
  profile: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
}

export interface HostCommandOptions {
  worktreePath: string;
  request: StructuredCommandRequest;
  profiles?: Readonly<Record<string, CommandProfile>>;
  environment?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  signal?: AbortSignal;
}

export interface PreparedHostCommand {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  profile: CommandProfile;
}

export type ManualCommandCategory =
  | "authentication"
  | "elevated_permission"
  | "destructive"
  | "external_side_effect";

export interface AuditedHostCommandOptions extends HostCommandOptions {
  allowedWriteScopes: readonly string[];
  maxOutputBytes?: number;
  captureSnapshot?: (worktreePath: string) => Promise<RepositoryCommandSnapshot>;
  onAudit?: (event: HostCommandAuditEvent) => Promise<void> | void;
}

export interface HostCommandAuditEvent {
  timestamp: string;
  decision: "allow" | "deny" | "reject";
  code: string;
  request: StructuredCommandRequest;
  violations?: readonly string[];
}

export interface AuditedHostCommandResult {
  process: ProcessResult;
  audit: CommandScopeAudit;
  acceptedAsEvidence: boolean;
}

export class HostCommandError extends Error {
  constructor(
    readonly code:
      | "HOST_COMMAND_PROHIBITED"
      | "HOST_COMMAND_GIT_DENIED"
      | "HOST_COMMAND_OUTPUT_LIMIT"
      | "HOST_COMMAND_TIMEOUT"
      | "HOST_COMMAND_CANCELLED"
      | "HOST_COMMAND_SPAWN_FAILED",
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostCommandError";
  }
}

const READ_ONLY_GIT_COMMANDS = new Set([
  "cat-file",
  "diff",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "merge-base",
  "rev-parse",
  "show",
  "status",
  "symbolic-ref",
]);

function rejectionAudit(
  request: StructuredCommandRequest,
  reason: string,
): Readonly<Record<string, unknown>> {
  return {
    decision: "deny",
    reason,
    profile: request.profile,
    executable: request.executable,
    args: [...request.args],
    cwd: request.cwd,
  };
}

async function emitAudit(
  options: AuditedHostCommandOptions,
  decision: HostCommandAuditEvent["decision"],
  code: string,
  violations?: readonly string[],
): Promise<void> {
  await options.onAudit?.({
    timestamp: new Date().toISOString(),
    decision,
    code,
    request: options.request,
    violations,
  });
}

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function minimalEnvironment(
  profile: CommandProfile,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(profile.environment.flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

export async function prepareHostCommand(options: HostCommandOptions): Promise<PreparedHostCommand> {
  const profile = resolveCommandProfile(options.request.profile, options.profiles ?? COMMAND_PROFILES);
  const executable = validateExecutable(profile, options.request.executable);
  const args = validateArguments(options.request.args);
  const timeoutMs = validateTimeout(profile, options.request.timeoutMs);
  const worktreePath = await realpath(options.worktreePath);
  let cwd: string;
  try {
    cwd = await realpath(options.request.cwd);
  } catch (error) {
    throw new CommandProfileError(
      "COMMAND_ARGUMENT_INVALID",
      "Command working directory does not exist",
      { cwd: options.request.cwd },
    );
  }
  if (!inside(worktreePath, cwd)) {
    throw new CommandProfileError(
      "COMMAND_ARGUMENT_INVALID",
      "Command working directory must be inside the selected worktree",
      { worktreePath, cwd },
    );
  }
  return {
    executable,
    args,
    cwd,
    timeoutMs,
    env: minimalEnvironment(profile, options.environment ?? process.env),
    profile,
  };
}

export async function runHostCommand(options: HostCommandOptions): Promise<ProcessResult> {
  const command = await prepareHostCommand(options);
  return (options.runner ?? runProcess)(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    timeoutMs: command.timeoutMs,
    signal: options.signal,
  });
}

export function classifyProhibitedCommand(
  request: StructuredCommandRequest,
): ManualCommandCategory | null {
  const executable = request.executable.toLocaleLowerCase().replace(/\.exe$/, "");
  const args = request.args.map((argument) => argument.toLocaleLowerCase());
  if (["sudo", "doas", "runas"].includes(executable)) return "elevated_permission";
  if (
    (["npm", "bun", "docker"].includes(executable) && args[0] === "login") ||
    (executable === "gh" && args[0] === "auth")
  ) return "authentication";
  if (executable === "git") {
    if (
      (args[0] === "push" && args.some((argument) => argument === "--force" || argument === "-f")) ||
      (args[0] === "reset" && args.includes("--hard")) ||
      (args[0] === "clean" && args.some((argument) => /^-[a-z]*f/i.test(argument))) ||
      (args[0] === "branch" && args.includes("-d")) ||
      (args[0] === "worktree" && args[1] === "remove")
    ) return "destructive";
    if (args[0] === "push") return "external_side_effect";
  }
  if (["npm", "bun"].includes(executable) && args[0] === "publish") return "external_side_effect";
  return null;
}

function runBoundedProcess(
  command: PreparedHostCommand,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (signal?.aborted) {
    return Promise.reject(new HostCommandError("HOST_COMMAND_CANCELLED", "Host command was cancelled before start"));
  }
  return new Promise((resolveResult, rejectResult) => {
    const startedAt = performance.now();
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let terminalError: HostCommandError | null = null;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const signalTree = (childSignal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, childSignal);
        else child.kill(childSignal);
      } catch {
        try { child.kill(childSignal); } catch {}
      }
    };
    const terminate = (error: HostCommandError) => {
      if (terminalError) return;
      terminalError = error;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => { if (!closed) signalTree("SIGKILL"); }, 1_000);
      killTimer.unref();
    };
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        terminate(new HostCommandError(
          "HOST_COMMAND_OUTPUT_LIMIT",
          `Host command output exceeded ${maxOutputBytes} bytes`,
          { maxOutputBytes },
        ));
        return;
      }
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    const onAbort = () => terminate(new HostCommandError("HOST_COMMAND_CANCELLED", "Host command was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    const timeout = setTimeout(() => terminate(new HostCommandError(
      "HOST_COMMAND_TIMEOUT",
      `Host command exceeded ${command.timeoutMs}ms`,
      { timeoutMs: command.timeoutMs },
    )), command.timeoutMs);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      closed = true;
      cleanup();
      rejectResult(new HostCommandError("HOST_COMMAND_SPAWN_FAILED", error.message, {}, { cause: error }));
    });
    child.once("close", (exitCode, childSignal) => {
      closed = true;
      cleanup();
      if (terminalError) {
        rejectResult(terminalError);
        return;
      }
      resolveResult({
        command: command.executable,
        args: command.args,
        exitCode,
        signal: childSignal,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt,
      });
    });
  });
}

export async function runAuditedHostCommand(
  options: AuditedHostCommandOptions,
): Promise<AuditedHostCommandResult> {
  const category = classifyProhibitedCommand(options.request);
  if (category) {
    const reason = `Host command requires a ${category} manual checkpoint`;
    await emitAudit(options, "deny", "HOST_COMMAND_PROHIBITED", [reason]);
    throw new HostCommandError(
      "HOST_COMMAND_PROHIBITED",
      reason,
      { category, request: options.request, audit: rejectionAudit(options.request, reason) },
    );
  }
  const executable = options.request.executable.toLocaleLowerCase().replace(/\.exe$/, "");
  const gitCommand = options.request.args[0]?.toLocaleLowerCase();
  if (executable === "git" && (!gitCommand || !READ_ONLY_GIT_COMMANDS.has(gitCommand))) {
    const reason = `Git subcommand ${gitCommand ?? "<missing>"} is not authorized for child execution`;
    await emitAudit(options, "deny", "HOST_COMMAND_GIT_DENIED", [reason]);
    throw new HostCommandError(
      "HOST_COMMAND_GIT_DENIED",
      reason,
      { request: options.request, audit: rejectionAudit(options.request, reason) },
    );
  }
  let prepared: PreparedHostCommand;
  try {
    prepared = await prepareHostCommand(options);
  } catch (error) {
    await emitAudit(options, "deny", error instanceof CommandProfileError ? error.code : "HOST_COMMAND_PREPARE_FAILED", [error instanceof Error ? error.message : String(error)]);
    throw error;
  }
  const capture = options.captureSnapshot ?? captureRepositoryCommandSnapshot;
  const before = await capture(options.worktreePath);
  let processResult: ProcessResult;
  try {
    processResult = options.runner
      ? await runHostCommand(options)
      : await runBoundedProcess(prepared, options.maxOutputBytes ?? 262_144, options.signal);
  } catch (error) {
    await emitAudit(options, "reject", error instanceof HostCommandError ? error.code : "HOST_COMMAND_FAILED", [error instanceof Error ? error.message : String(error)]);
    throw error;
  }
  if (options.runner) {
    const outputBytes = Buffer.byteLength(processResult.stdout) + Buffer.byteLength(processResult.stderr);
    if (outputBytes > (options.maxOutputBytes ?? 262_144)) {
      await emitAudit(options, "reject", "HOST_COMMAND_OUTPUT_LIMIT", [`Output was ${outputBytes} bytes`]);
      throw new HostCommandError("HOST_COMMAND_OUTPUT_LIMIT", "Host command output exceeded its configured limit", {
        outputBytes,
        maxOutputBytes: options.maxOutputBytes ?? 262_144,
      });
    }
  }
  const after = await capture(options.worktreePath);
  const audit = auditRepositoryCommand(before, after, options.allowedWriteScopes);
  const acceptedAsEvidence = processResult.exitCode === 0 && audit.accepted;
  await emitAudit(
    options,
    acceptedAsEvidence ? "allow" : "reject",
    acceptedAsEvidence ? "HOST_COMMAND_ACCEPTED" : "HOST_COMMAND_EVIDENCE_REJECTED",
    audit.violations,
  );
  return {
    process: processResult,
    audit,
    acceptedAsEvidence,
  };
}