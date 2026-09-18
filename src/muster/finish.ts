import { resolve } from "node:path";
import { finishChange } from "../controller/finish.ts";
import { computeSourceDigest } from "../execution/change-digests.ts";
import { GitAdapter } from "../execution/git.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createChangeUsageStore, changeRunId } from "../persistence/change-usage-store.ts";
import { runManifestSchema } from "../persistence/records.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../review/artifact-digest.ts";
import type { ParsedChangeCommand, ChangeCommandContext } from "../runtime/change-command.ts";
import type { CommandOutcome, ProductionRuntimeOptions } from "../runtime/command.ts";
import type { ProductionVerificationOptions } from "./verify.ts";

export async function runProductionFinish(options: ProductionVerificationOptions): Promise<CommandOutcome> {
  const adapter = options.openSpec ?? new OpenSpecAdapter({ cwd: options.cwd, signal: options.signal });
  const status = await adapter.status(options.changeName);
  const changeRoot = resolve(status.changeRoot);
  const store = createChangeUsageStore(options.cwd);
  const runId = changeRunId(options.changeName);
  const manifest = runManifestSchema.parse(await store.read(runId, "manifest.json"));
  const result = await finishChange({ changeName: options.changeName, changeRoot }, {
    readCurrentDigests: async () => {
      const artifactDigest = await hashReviewedArtifacts(await discoverReviewedArtifacts(options.cwd, changeRoot));
      const git = new GitAdapter(manifest.worktree.path, undefined, undefined, options.signal);
      const [head, diff] = await Promise.all([git.head(), git.diff()]);
      return { artifactDigest, sourceDigest: computeSourceDigest(head.commit, diff) };
    },
    archive: (changeName) => adapter.archive(changeName),
  });
  return {
    status: "success",
    action: "finish",
    changeName: options.changeName,
    runId,
    summary: `Archived ${result.archive.archive.change} as ${result.archive.archive.archivedAs}.`,
  };
}

/** Builds the `/change finish` handler bound to the given cwd/options closure. */
export function createFinishHandler(cwd: string, options: ProductionRuntimeOptions) {
  return async function finishHandler(
    command: ParsedChangeCommand & { changeName?: string },
    _context: ChangeCommandContext,
  ): Promise<CommandOutcome | void> {
    return (options.runners?.finish ?? runProductionFinish)({
      cwd,
      changeName: command.changeName!,
      signal: options.signal,
      argv: options.argv,
    });
  };
}
