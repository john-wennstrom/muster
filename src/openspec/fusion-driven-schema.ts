import { cp, mkdir } from "node:fs/promises";
import { platform as osPlatform, homedir as osHomedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "../shared/errors.ts";

/**
 * The schema muster's own change pipeline is built against: `harness-task`
 * checkboxes (execution/task-parser.ts, execution/task-schema.ts) and a
 * digest-bound review.md gating apply (change/phases/review.ts,
 * change/phases/verification.ts). OpenSpec's stock `spec-driven` schema knows
 * neither, so a change created under it produces a tasks.md the implement
 * phase cannot parse.
 */
export const FUSION_DRIVEN_SCHEMA_NAME = "fusion-driven";

/**
 * The artifacts muster's own `propose`/`refine` phase writes, and the ones
 * that must all be `done` before muster considers planning finished and
 * advances the change lifecycle out of PLANNING. Deliberately excludes
 * `review`/`verification`: OpenSpec's own `isPlanningComplete`/
 * `actionContext.planningArtifacts` count those too (they're part of this
 * schema's dependency graph), but muster treats them as separate,
 * lifecycle-gated phases (change/phases/review.ts, verification.ts) that
 * only run once PLANNING has already advanced to REVIEW_REQUIRED — so
 * gating "planning complete" on them would make that transition
 * unreachable.
 */
export const CORE_PLANNING_ARTIFACT_IDS: ReadonlySet<string> = new Set([
  "proposal",
  "specs",
  "design",
  "tasks",
]);

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Muster's own canonical copy of the schema, shipped via package.json's `files`. */
export function fusionDrivenSchemaSource(): string {
  return resolve(PACKAGE_ROOT, "schemas", FUSION_DRIVEN_SCHEMA_NAME);
}

/**
 * OpenSpec's user-schema override directory (its resolver checks project-local,
 * then this, then its own package-bundled schemas). Mirrors the XDG resolution
 * in @fission-ai/openspec's `getGlobalDataDir` so a schema installed here is
 * found by name from any repo on this machine, with no per-project setup.
 */
export function openSpecUserSchemasDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdgDataHome = env.XDG_DATA_HOME;
  if (xdgDataHome) return join(xdgDataHome, "openspec", "schemas");
  if (osPlatform() === "win32") {
    const base = env.LOCALAPPDATA ?? join(osHomedir(), "AppData", "Local");
    return join(base, "openspec", "schemas");
  }
  return join(osHomedir(), ".local", "share", "openspec", "schemas");
}

/**
 * Copies muster's `fusion-driven` schema into OpenSpec's user-schema
 * directory so `openspec new change --schema fusion-driven` resolves it
 * without touching the target repo. Cheap and idempotent — safe to call
 * before every change creation so a schema fix in muster propagates.
 */
export async function ensureFusionDrivenSchemaInstalled(
  options: { source?: string; destinationDir?: string } = {},
): Promise<string> {
  const source = options.source ?? fusionDrivenSchemaSource();
  const destination = join(options.destinationDir ?? openSpecUserSchemasDir(), FUSION_DRIVEN_SCHEMA_NAME);
  try {
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  } catch (cause) {
    throw new HarnessError(
      "OPENSPEC_SCHEMA_INSTALL_FAILED",
      `Failed to install the fusion-driven OpenSpec schema at ${destination}`,
      { source, destination },
      { cause },
    );
  }
  return destination;
}
