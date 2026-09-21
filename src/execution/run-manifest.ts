import { resolve } from "node:path";
import { readLane } from "../controller/lane.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { runManifestSchema, type RunManifest } from "../persistence/records.ts";
import { HarnessError } from "../shared/errors.ts";
import { computeDiffDigest, computeIndexDigest } from "./change-digests.ts";
import type { ValidatedTaskDocument } from "./task-schema.ts";
import type { ChangeWorktree } from "./worktree.ts";

const MANIFEST_PATH = "manifest.json";

export interface OpenRunManifestInput {
  store: AtomicJsonStore;
  runId: string;
  changeName: string;
  worktree: ChangeWorktree;
  artifactDigest: string;
  document: ValidatedTaskDocument;
  /** What a new manifest records; an existing one is checked against the selected worktree instead. */
  creation: {
    head: string;
    gitStatus: Parameters<typeof computeIndexDigest>[0];
    diff: string;
    modelAssignments: Record<string, string>;
  };
  now: () => Date;
}

/**
 * The single owner of a change run's manifest: it creates, reads, identity-checks and persists it,
 * and records the change's lane on it. Everything that changes the manifest goes through here, so
 * there is one writer of `manifest.json`.
 */
export class RunManifestKeeper {
  /** True when the reviewed artifacts changed since the manifest was written. */
  readonly artifactChanged: boolean;
  private manifest: RunManifest;

  private constructor(
    private readonly store: AtomicJsonStore,
    manifest: RunManifest,
    artifactChanged: boolean,
    private readonly now: () => Date,
  ) {
    this.manifest = manifest;
    this.artifactChanged = artifactChanged;
  }

  static async open(input: OpenRunManifestInput): Promise<RunManifestKeeper> {
    const lane = (await readLane(input.store, input.changeName)).lane;
    try {
      const existing = runManifestSchema.parse(await input.store.read(input.runId, MANIFEST_PATH));
      if (
        existing.changeName !== input.changeName ||
        existing.repository.id !== input.worktree.repositoryId ||
        resolve(existing.worktree.path) !== resolve(input.worktree.path)
      ) {
        throw new HarnessError("RECOVERY_STATE_CONFLICT", "Persisted implementation identity does not match the selected change worktree", {
          runId: input.runId,
          changeName: input.changeName,
        });
      }
      const keeper = new RunManifestKeeper(input.store, existing, existing.artifactDigest !== input.artifactDigest, input.now);
      // The lane can have moved since the run was created, so it is refreshed on every read.
      if (existing.lane !== lane) await keeper.write({ ...existing, lane });
      return keeper;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const timestamp = input.now().toISOString();
    const created = runManifestSchema.parse({
      schemaVersion: 1,
      runId: input.runId,
      changeName: input.changeName,
      lifecycle: "READY",
      repository: { id: input.worktree.repositoryId, commonDirectory: input.worktree.commonDirectory },
      worktree: {
        path: input.worktree.path,
        head: input.creation.head,
        indexDigest: computeIndexDigest(input.creation.gitStatus),
        diffDigest: computeDiffDigest(input.creation.diff),
      },
      artifactDigest: input.artifactDigest,
      tasks: Object.fromEntries(input.document.tasks.map((task) => [task.id, task.checked ? "completed" : "ready"])),
      modelAssignments: input.creation.modelAssignments,
      writer: null,
      checkpoints: [],
      lane,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const keeper = new RunManifestKeeper(input.store, created, false, input.now);
    await keeper.write(created);
    return keeper;
  }

  get current(): RunManifest {
    return this.manifest;
  }

  private async write(next: RunManifest): Promise<void> {
    this.manifest = runManifestSchema.parse(next);
    await this.store.write(this.manifest.runId, MANIFEST_PATH, this.manifest);
  }

  /** Records one task's state, and any checkpoints now pending, as the run progresses. */
  async recordTask(taskId: string, state: RunManifest["tasks"][string], pendingCheckpointIds: readonly string[]): Promise<void> {
    await this.write({
      ...this.manifest,
      lifecycle: state === "awaiting_user" ? "AWAITING_USER" : state === "design_conflict" ? "DESIGN_CONFLICT" : "IMPLEMENTING",
      tasks: { ...this.manifest.tasks, [taskId]: state },
      checkpoints: [...new Set([...this.manifest.checkpoints, ...pendingCheckpointIds])],
      updatedAt: this.now().toISOString(),
    });
  }

  /** Records the lane after an escalation, so final validation reads what the run last ran under. */
  async recordLane(lane: NonNullable<RunManifest["lane"]>): Promise<void> {
    await this.write({ ...this.manifest, lane, updatedAt: this.now().toISOString() });
  }

  /** Records where the run ended: the lifecycle it reached and every task's final scheduler state. */
  async finish(lifecycle: RunManifest["lifecycle"], schedulerStates: Readonly<Record<string, string>>): Promise<void> {
    await this.write({
      ...this.manifest,
      lifecycle,
      // The schema rejects a state a manifest cannot hold, as it did when the phase wrote this itself.
      tasks: { ...this.manifest.tasks, ...schedulerStates } as RunManifest["tasks"],
      updatedAt: this.now().toISOString(),
    });
  }
}
