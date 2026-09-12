import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { HarnessError } from "./errors.ts";

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

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
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