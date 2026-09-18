import { handshakeOpenSpec, type OpenSpecHandshake } from "./handshake.ts";
import {
  openSpecApplySchema,
  openSpecArchiveSchema,
  openSpecCreateSchema,
  openSpecInstructionsSchema,
  openSpecStatusSchema,
  openSpecValidateSchema,
  parseOpenSpecJson,
  type OpenSpecApplyInstructions,
  type OpenSpecArchive,
  type OpenSpecCreate,
  type OpenSpecInstructions,
  type OpenSpecStatus,
  type OpenSpecValidation,
} from "./protocol.ts";
import { HarnessError } from "../shared/errors.ts";
import {
  runProcess,
  type ProcessResult,
  type ProcessRunner,
} from "../shared/process.ts";

export interface OpenSpecAdapterOptions {
  cwd: string;
  executable?: string;
  runner?: ProcessRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class OpenSpecAdapter {
  readonly cwd: string;
  readonly executable: string;
  readonly timeoutMs: number;
  private readonly runner: ProcessRunner;
  private readonly signal?: AbortSignal;

  constructor(options: OpenSpecAdapterOptions) {
    this.cwd = options.cwd;
    this.executable = options.executable ?? "openspec";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.runner = options.runner ?? runProcess;
    this.signal = options.signal;
  }

  detect(): Promise<OpenSpecHandshake> {
    return handshakeOpenSpec({
      cwd: this.cwd,
      executable: this.executable,
      runner: this.runner,
      signal: this.signal,
      timeoutMs: this.timeoutMs,
    });
  }

  async status(change: string): Promise<OpenSpecStatus> {
    return this.structured(
      ["status", "--change", change, "--json"],
      "status",
      openSpecStatusSchema,
    );
  }

  async instructions(
    artifact: string,
    change: string,
  ): Promise<OpenSpecInstructions> {
    return this.structured(
      ["instructions", artifact, "--change", change, "--json"],
      `instructions ${artifact}`,
      openSpecInstructionsSchema,
    );
  }

  async applyInstructions(change: string): Promise<OpenSpecApplyInstructions> {
    return this.structured(
      ["instructions", "apply", "--change", change, "--json"],
      "instructions apply",
      openSpecApplySchema,
    );
  }

  async validate(change: string): Promise<OpenSpecValidation> {
    return this.structured(
      ["validate", change, "--type", "change", "--strict", "--json"],
      "validate",
      openSpecValidateSchema,
    );
  }

  async archive(change: string): Promise<OpenSpecArchive> {
    return this.structured(
      ["archive", change, "--json", "--yes"],
      "archive",
      openSpecArchiveSchema,
    );
  }

  async createChange(change: string, description: string): Promise<OpenSpecCreate> {
    return this.structured(
      ["new", "change", change, "--description", description, "--json"],
      "new change",
      openSpecCreateSchema,
    );
  }

  private async command(args: readonly string[]): Promise<ProcessResult> {
    const result = await this.runner(this.executable, args, {
      cwd: this.cwd,
      signal: this.signal,
      timeoutMs: this.timeoutMs,
    });
    if (result.exitCode === 0) return result;

    throw new HarnessError(
      "OPENSPEC_COMMAND_FAILED",
      `OpenSpec command failed with exit ${result.exitCode}: ${args.join(" ")}`,
      {
        args,
        cwd: this.cwd,
        exitCode: result.exitCode,
        stderr: result.stderr.trim(),
        stdout: result.stdout.trim(),
      },
    );
  }

  private async structured<TSchema extends Parameters<typeof parseOpenSpecJson>[2]>(
    args: readonly string[],
    label: string,
    schema: TSchema,
  ): Promise<ReturnType<typeof parseOpenSpecJson<TSchema>>> {
    const result = await this.command(args);
    return parseOpenSpecJson(label, result.stdout, schema);
  }
}
