import {
  confirmManualCheckpoint,
  type ConfirmManualCheckpointInput,
} from "./manual-checkpoint.ts";
import {
  runImplementationFlow,
  type ImplementationFlowOptions,
  type ImplementationFlowResult,
} from "../execution/implementation-flow.ts";
import type { RecoveryAction } from "./recovery.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import type { CheckpointRecord } from "../persistence/records.ts";
import { HarnessError } from "../shared/errors.ts";

export interface ImplementChangeInput {
  changeName: string;
  flow: ImplementationFlowOptions;
}

export interface ResumeChangeInput extends ImplementChangeInput {
  checkpointId: string;
  confirmedBy: string;
  store: AtomicJsonStore;
  now?: ConfirmManualCheckpointInput["now"];
}

export interface ResumeChangeResult {
  checkpoint: CheckpointRecord;
  implementation: ImplementationFlowResult;
}

export interface ImplementControllerDependencies {
  runFlow(options: ImplementationFlowOptions): Promise<ImplementationFlowResult>;
  confirmCheckpoint(input: ConfirmManualCheckpointInput): Promise<CheckpointRecord>;
}

const defaultDependencies: ImplementControllerDependencies = {
  runFlow: runImplementationFlow,
  confirmCheckpoint: confirmManualCheckpoint,
};

function assertFlowIdentity(input: ImplementChangeInput): void {
  if (input.flow.scheduler.worktree.changeName !== input.changeName) {
    throw new HarnessError(
      "WORKTREE_UNSAFE",
      "Implementation worktree options belong to a different change",
      {
        changeName: input.changeName,
        worktreeChangeName: input.flow.scheduler.worktree.changeName,
      },
    );
  }
}

async function runPreparedFlow(
  input: ImplementChangeInput,
  dependencies: ImplementControllerDependencies,
): Promise<ImplementationFlowResult> {
  assertFlowIdentity(input);
  const pendingCheckpointIds = new Set(
    (input.flow.scheduler.pendingCheckpoints ?? [])
      .filter((checkpoint) => checkpoint.status === "pending")
      .map((checkpoint) => checkpoint.id),
  );
  const remainingRecoveryActions: RecoveryAction[] = [];
  for (const action of input.flow.recovery.actions) {
    if (action.type !== "restore_checkpoint") {
      remainingRecoveryActions.push(action);
      continue;
    }
    if (!pendingCheckpointIds.has(action.checkpointId)) {
      throw new HarnessError(
        "MANUAL_CHECKPOINT_MISMATCH",
        `Recovery checkpoint ${action.checkpointId} is not pending for this implementation run`,
        { checkpointId: action.checkpointId, taskId: action.taskId },
      );
    }
    await input.flow.executeRecoveryAction(action);
  }

  return dependencies.runFlow({
    ...input.flow,
    recovery: {
      ...input.flow.recovery,
      actions: remainingRecoveryActions,
    },
  });
}

export function implementChange(
  input: ImplementChangeInput,
  overrides: Partial<ImplementControllerDependencies> = {},
): Promise<ImplementationFlowResult> {
  return runPreparedFlow(input, { ...defaultDependencies, ...overrides });
}

export async function resumeChange(
  input: ResumeChangeInput,
  overrides: Partial<ImplementControllerDependencies> = {},
): Promise<ResumeChangeResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  assertFlowIdentity(input);
  const checkpoint = input.flow.scheduler.pendingCheckpoints?.find(
    (candidate) => candidate.id === input.checkpointId && candidate.status === "pending",
  );
  if (!checkpoint) {
    throw new HarnessError(
      "MANUAL_RESUME_INVALID",
      `Manual checkpoint ${input.checkpointId} is not pending for this implementation run`,
      { checkpointId: input.checkpointId, runId: input.flow.scheduler.runId },
    );
  }

  const confirmed = await dependencies.confirmCheckpoint({
    store: input.store,
    runId: input.flow.scheduler.runId,
    changeName: input.changeName,
    checkpointId: input.checkpointId,
    confirmedBy: input.confirmedBy,
    now: input.now,
  });
  const implementation = await runPreparedFlow({
    changeName: input.changeName,
    flow: {
      ...input.flow,
      recovery: {
        ...input.flow.recovery,
        actions: input.flow.recovery.actions.filter((action) =>
          action.type !== "restore_checkpoint" || action.checkpointId !== confirmed.id
        ),
      },
      scheduler: {
        ...input.flow.scheduler,
        pendingCheckpoints: input.flow.scheduler.pendingCheckpoints?.filter(
          (candidate) => candidate.id !== confirmed.id && candidate.status === "pending",
        ),
      },
    },
  }, dependencies);
  return { checkpoint: confirmed, implementation };
}