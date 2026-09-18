import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { HarnessError } from "./errors.ts";

// Windows CreateProcess (unlike a shell) will not resolve PATHEXT for a bare
// command name, so npm/npx/openspec/etc. installed as `.cmd`/`.bat` shims
// fail with ENOENT under `spawn(..., { shell: false })`. We resolve the shim's
// full path ourselves and, for `.cmd`/`.bat` shims specifically, spawn it
// through `cmd.exe` with the executable and arguments kept as separate array
// elements (never concatenated into a shell string) so quoting is still
// handled by the child_process layer rather than by us.
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];
const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat"]);

function resolveExecutable(command: string): string {
  if (process.platform !== "win32") return command;
  if (/[\\/]/.test(command) || isAbsolute(command)) return command;
  if (/\.[^\\/]+$/.test(command)) return command;

  const pathDirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function requiresWindowsShellWrapper(resolvedCommand: string): boolean {
  if (process.platform !== "win32") return false;
  const match = /\.[^\\/]+$/.exec(resolvedCommand);
  return match !== undefined && match !== null && WINDOWS_SHELL_EXTENSIONS.has(match[0].toLowerCase());
}

export interface ProcessRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ProcessResult {
  command: string;
  args: readonly string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
) => Promise<ProcessResult>;

export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return Promise.reject(
      new HarnessError("PROCESS_CANCELLED", `${command} was cancelled before it started`, {
        command,
        args,
      }),
    );
  }

  return new Promise((resolveResult, rejectResult) => {
    const startedAt = performance.now();
    let stdout = "";
    let stderr = "";
    let terminalError: HarnessError | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const resolvedCommand = resolveExecutable(command);
    const child = spawn(resolvedCommand, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: requiresWindowsShellWrapper(resolvedCommand),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const terminate = (error: HarnessError): void => {
      if (terminalError) return;
      terminalError = error;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKillTimer.unref();
    };

    const abort = (): void => {
      terminate(
        new HarnessError("PROCESS_CANCELLED", `${command} was cancelled`, {
          command,
          args,
        }),
      );
    };

    const timeout = setTimeout(() => {
      terminate(
        new HarnessError("PROCESS_TIMEOUT", `${command} exceeded ${options.timeoutMs}ms`, {
          command,
          args,
          timeoutMs: options.timeoutMs,
        }),
      );
    }, options.timeoutMs);
    timeout.unref();

    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (cause) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      rejectResult(
        new HarnessError(
          "PROCESS_SPAWN_FAILED",
          `Failed to start ${command}: ${cause.message}`,
          { command, args, cwd: options.cwd },
          { cause },
        ),
      );
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      if (terminalError) {
        rejectResult(terminalError);
        return;
      }
      resolveResult({
        command,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt,
      });
    });
  });
}