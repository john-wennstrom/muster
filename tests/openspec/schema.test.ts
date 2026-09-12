import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runProcess } from "../../src/shared/process.ts";

const projectRoot = resolve(import.meta.dir, "../..");
const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function openspec(cwd: string, args: string[]): Promise<Record<string, any>> {
  const result = await runProcess("openspec", args, { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

describe("fusion-driven schema", () => {
  test("resolves the full artifact graph and gates apply on tracked tasks review", async () => {
    const fixture = await mkdtemp(resolve(tmpdir(), "muster-schema-"));
    temporaryProjects.push(fixture);
    await mkdir(resolve(fixture, "openspec/schemas"), { recursive: true });
    await cp(
      resolve(projectRoot, "schemas/fusion-driven"),
      resolve(fixture, "openspec/schemas/fusion-driven"),
      { recursive: true },
    );
    await writeFile(resolve(fixture, "openspec/config.yaml"), "schema: fusion-driven\n");

    await openspec(fixture, ["schema", "validate", "fusion-driven", "--json"]);
    await openspec(fixture, ["new", "change", "sample", "--schema", "fusion-driven", "--json"]);
    const status = await openspec(fixture, ["status", "--change", "sample", "--json"]);

    expect(status.schemaName).toBe("fusion-driven");
    expect(status.artifacts.map((artifact: { id: string }) => artifact.id)).toEqual([
      "proposal",
      "specs",
      "design",
      "tasks",
      "review",
      "verification",
    ]);
    expect(status.applyRequires).toEqual(["review"]);

    const changeDir = resolve(fixture, "openspec/changes/sample");
    await mkdir(resolve(changeDir, "specs/search"), { recursive: true });
    await Promise.all([
      writeFile(resolve(changeDir, "proposal.md"), "## Why\n\nTest.\n"),
      writeFile(resolve(changeDir, "specs/search/spec.md"), "## ADDED Requirements\n"),
      writeFile(resolve(changeDir, "design.md"), "## Context\n\nTest.\n"),
      writeFile(resolve(changeDir, "tasks.md"), "## 1. Build\n\n- [ ] 1.1 Implement\n"),
      writeFile(resolve(changeDir, "review.md"), "# Planning Review\n\n- Verdict: APPROVE\n"),
    ]);

    const apply = await openspec(fixture, ["instructions", "apply", "--change", "sample", "--json"]);
    expect(apply.state).toBe("ready");
    expect(apply.progress).toEqual({ total: 1, complete: 0, remaining: 1 });
    expect(apply.contextFiles.review).toEqual([resolve(changeDir, "review.md")]);
  });
});