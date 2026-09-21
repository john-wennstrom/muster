import { parseVerificationCommand } from "../../../execution/verification-command.ts";
import type { TaskPipelineVerificationResult } from "../../../execution/task-runner.ts";
import type { ValidatedTask } from "../../../execution/task-schema.ts";
import { runHostCommand } from "../../../tools/host-runner.ts";

/** Runs a task's declared verification commands in its worktree, stopping at the first failure. */
export async function runVerificationStep(
  task: ValidatedTask,
  worktreePath: string,
  signal?: AbortSignal,
  runCommand: typeof runHostCommand = runHostCommand,
): Promise<TaskPipelineVerificationResult> {
  const evidence: string[] = [];
  for (const command of task.verify) {
    const parsed = parseVerificationCommand(command);
    const result = await runCommand({
      worktreePath,
      request: {
        profile: "verification",
        executable: parsed.executable,
        args: parsed.args,
        cwd: worktreePath,
      },
      signal,
    });
    evidence.push(`${command}: exit ${result.exitCode}`);
    if (result.exitCode !== 0) {
      return { passed: false, evidence, failure: { command, exitCode: result.exitCode, output: `${result.stdout ?? ""}${result.stderr ?? ""}` } };
    }
  }
  return { passed: true, evidence };
}
