import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  resolveCurrentState,
  type StatePrecedenceInput,
} from "../../src/controller/state-precedence.ts";
import {
  openSpecApplySchema,
  openSpecStatusSchema,
} from "../../src/openspec/protocol.ts";

const fixtures = resolve(import.meta.dir, "../fixtures");

async function load(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve(fixtures, path), "utf8"));
}

describe("durable state precedence", () => {
  test("validated OpenSpec and repository state override runtime and memory", async () => {
    const protocol = await load("openspec/protocol-valid.json");
    const conflicts = await load("controller/precedence-conflicts.json");
    const input: StatePrecedenceInput = {
      openSpec: {
        status: openSpecStatusSchema.parse(protocol.status),
        apply: openSpecApplySchema.parse(protocol.apply),
      },
      repository: conflicts.repository,
      runtime: conflicts.runtime,
      supplemental: [conflicts.memory],
    };

    const current = resolveCurrentState(input);

    expect(current.changeName).toBe("add-search");
    expect(current.schemaName).toBe("spec-driven");
    expect(current.applyState).toBe("ready");
    expect(current.tasks).toEqual([
      { id: "1", description: "1.1 Add search", done: false },
    ]);
    expect(current.repository).toEqual(conflicts.repository);
    expect(current.runtime).toEqual({ runId: "run-17" });
    expect(current.supplemental).toEqual([
      { source: "hindsight", preferences: ["keep reviews concise"] },
    ]);
    expect(current.conflicts.map((conflict) => conflict.field)).toEqual(
      expect.arrayContaining([
        "changeName",
        "schemaName",
        "applyState",
        "tasks",
        "repositoryId",
        "worktree",
        "head",
        "diffDigest",
      ]),
    );
    expect(current.conflicts.every((conflict) => conflict.resolution === "ignored-lower-authority")).toBeTrue();
  });

  test("requires validated OpenSpec and repository observations", async () => {
    const protocol = await load("openspec/protocol-valid.json");
    const status = openSpecStatusSchema.parse(protocol.status);
    const apply = openSpecApplySchema.parse(protocol.apply);

    expect(() =>
      resolveCurrentState({
        openSpec: { status: { ...status, changeName: "other" }, apply },
        repository: {
          repositoryId: "repo",
          worktree: "/workspace",
          head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          diffDigest: "diff",
        },
      }),
    ).toThrow(expect.objectContaining({ code: "STATE_OBSERVATION_CONFLICT" }));
  });
});