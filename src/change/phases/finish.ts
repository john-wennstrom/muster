import { resolve } from "node:path";
import { finishChange } from "../../controller/finish.ts";
import { readSourceDigest } from "../../execution/change-digests.ts";
import { GitAdapter } from "../../execution/git.ts";
import { OpenSpecAdapter } from "../../openspec/adapter.ts";
import { openChangeRun } from "../../persistence/run-store.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../../review/artifact-digest.ts";
import type { CommandOutcome } from "../command.ts";
import type { AgentRunObserver } from "../agent-progress.ts";

export interface ProductionFinishOptions {
  cwd: string;
  changeName: string;
  onAgentStart?: AgentRunObserver;
  signal?: AbortSignal;
  argv?: readonly string[];
  openSpec?: OpenSpecAdapter;
  now?: () => Date;
}

export async function runProductionFinish(options: ProductionFinishOptions): Promise<CommandOutcome> {
  const adapter = options.openSpec ?? new OpenSpecAdapter({ cwd: options.cwd, signal: options.signal });
  const status = await adapter.status(options.changeName);
  const changeRoot = resolve(status.changeRoot);
  const run = openChangeRun(options.cwd, options.changeName);
  const manifest = await run.readManifest();
  const result = await finishChange({ changeName: options.changeName, changeRoot }, {
    readCurrentDigests: async () => {
      const artifactDigest = await hashReviewedArtifacts(await discoverReviewedArtifacts(options.cwd, changeRoot));
      const git = new GitAdapter(manifest.worktree.path, undefined, undefined, options.signal);
      return { artifactDigest, sourceDigest: (await readSourceDigest(git)).sourceDigest };
    },
    archive: (changeName) => adapter.archive(changeName),
  });
  return {
    status: "success",
    action: "finish",
    changeName: options.changeName,
    runId: run.runId,
    summary: `Archived ${result.archive.archive.change} as ${result.archive.archive.archivedAs}.`,
  };
}
