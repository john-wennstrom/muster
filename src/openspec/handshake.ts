import { openSpecContextSchema, parseOpenSpecJson } from "./protocol.ts";
import {
  runProcess,
  type ProcessResult,
  type ProcessRunner,
} from "../shared/process.ts";
import { HarnessError } from "../shared/errors.ts";

export const requiredOpenSpecCapabilities = [
  "context-json",
  "status-json",
  "artifact-instructions-json",
  "apply-instructions-json",
  "validate-json",
  "archive-json",
] as const;

export type OpenSpecCapability = (typeof requiredOpenSpecCapabilities)[number];

export interface OpenSpecHandshakeProbe {
  version: string;
  context: string;
  help: {
    status: string;
    instructions: string;
    validate: string;
    archive: string;
  };
}

export interface OpenSpecHandshake {
  version: string;
  capabilities: OpenSpecCapability[];
  diagnostics: string[];
}

function hasOptions(help: string, ...options: string[]): boolean {
  return options.every((option) => help.includes(option));
}

export function evaluateOpenSpecHandshake(
  probe: OpenSpecHandshakeProbe,
): OpenSpecHandshake {
  const capabilities: OpenSpecCapability[] = [];
  const diagnostics: string[] = [];

  try {
    parseOpenSpecJson("context --json", probe.context, openSpecContextSchema);
    capabilities.push("context-json");
  } catch (error) {
    diagnostics.push(
      `context-json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (hasOptions(probe.help.status, "--change", "--json")) {
    capabilities.push("status-json");
  } else {
    diagnostics.push("status-json: `openspec status` must support --change and --json");
  }

  if (hasOptions(probe.help.instructions, "[artifact", "--change", "--json")) {
    capabilities.push("artifact-instructions-json");
  } else {
    diagnostics.push(
      "artifact-instructions-json: `openspec instructions` must accept an artifact with --change and --json",
    );
  }

  if (hasOptions(probe.help.instructions, "apply", "--change", "--json")) {
    capabilities.push("apply-instructions-json");
  } else {
    diagnostics.push(
      "apply-instructions-json: `openspec instructions apply` with --change and --json is required",
    );
  }

  if (probe.help.validate.includes("--json")) {
    capabilities.push("validate-json");
  } else {
    diagnostics.push("validate-json: `openspec validate` must support --json");
  }

  if (probe.help.archive.includes("--json")) {
    capabilities.push("archive-json");
  } else {
    diagnostics.push("archive-json: `openspec archive` must support --json");
  }

  const missing = requiredOpenSpecCapabilities.filter(
    (capability) => !capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new HarnessError(
      "OPENSPEC_CAPABILITY_MISSING",
      `OpenSpec ${probe.version || "unknown version"} lacks required capabilities: ${missing.join(", ")}`,
      { version: probe.version || null, missing, diagnostics },
    );
  }

  return { version: probe.version, capabilities, diagnostics };
}

export interface OpenSpecHandshakeOptions {
  cwd: string;
  executable?: string;
  runner?: ProcessRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function outputOf(result: ProcessResult): string {
  return `${result.stdout}${result.stderr}`;
}

export async function handshakeOpenSpec(
  options: OpenSpecHandshakeOptions,
): Promise<OpenSpecHandshake> {
  const executable = options.executable ?? "openspec";
  const runner = options.runner ?? runProcess;
  const processOptions = {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 5_000,
  };
  const [version, context, status, instructions, validate, archive] =
    await Promise.all([
      runner(executable, ["--version"], processOptions),
      runner(executable, ["context", "--json"], processOptions),
      runner(executable, ["status", "--help"], processOptions),
      runner(executable, ["instructions", "--help"], processOptions),
      runner(executable, ["validate", "--help"], processOptions),
      runner(executable, ["archive", "--help"], processOptions),
    ]);

  const failed = [version, context, status, instructions, validate, archive].find(
    (result) => result.exitCode !== 0,
  );
  if (failed) {
    throw new HarnessError(
      "OPENSPEC_CAPABILITY_MISSING",
      `OpenSpec capability probe failed: ${failed.command} ${failed.args.join(" ")}`,
      {
        command: failed.command,
        args: failed.args,
        exitCode: failed.exitCode,
        stderr: failed.stderr.trim(),
      },
    );
  }

  return evaluateOpenSpecHandshake({
    version: version.stdout.trim(),
    context: context.stdout,
    help: {
      status: outputOf(status),
      instructions: outputOf(instructions),
      validate: outputOf(validate),
      archive: outputOf(archive),
    },
  });
}