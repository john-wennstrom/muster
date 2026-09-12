import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  discoverReviewedArtifacts,
  hashReviewedArtifacts,
} from "../../src/review/artifact-digest.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture(lineEnding = "\n") {
  const repositoryRoot = await mkdtemp(resolve(tmpdir(), "muster-review-digest-"));
  temporaryDirectories.push(repositoryRoot);
  const changeRoot = resolve(repositoryRoot, "openspec/changes/add-search");
  await mkdir(resolve(changeRoot, "specs/zeta"), { recursive: true });
  await mkdir(resolve(changeRoot, "specs/alpha"), { recursive: true });
  await writeFile(resolve(changeRoot, "tasks.md"), `tasks${lineEnding}`);
  await writeFile(resolve(changeRoot, "proposal.md"), `proposal${lineEnding}`);
  await writeFile(resolve(changeRoot, "design.md"), `design${lineEnding}`);
  await writeFile(resolve(changeRoot, "specs/zeta/spec.md"), `zeta${lineEnding}`);
  await writeFile(resolve(changeRoot, "specs/alpha/spec.md"), `alpha${lineEnding}`);
  return { repositoryRoot, changeRoot };
}

describe("reviewed artifact digest", () => {
  test("discovers the canonical reviewed set in repository-relative path order", async () => {
    const { repositoryRoot, changeRoot } = await fixture();

    const artifacts = await discoverReviewedArtifacts(repositoryRoot, changeRoot);

    expect(artifacts.map((artifact) => artifact.relativePath)).toEqual([
      "openspec/changes/add-search/design.md",
      "openspec/changes/add-search/proposal.md",
      "openspec/changes/add-search/specs/alpha/spec.md",
      "openspec/changes/add-search/specs/zeta/spec.md",
      "openspec/changes/add-search/tasks.md",
    ]);
  });

  test("is stable when artifact input order changes", async () => {
    const { repositoryRoot, changeRoot } = await fixture();
    const artifacts = await discoverReviewedArtifacts(repositoryRoot, changeRoot);

    const forward = await hashReviewedArtifacts(artifacts);
    const reverse = await hashReviewedArtifacts([...artifacts].reverse());

    expect(reverse).toBe(forward);
  });

  test("changes for line-ending, content, and path changes", async () => {
    const lf = await fixture("\n");
    const crlf = await fixture("\r\n");
    const lfArtifacts = await discoverReviewedArtifacts(lf.repositoryRoot, lf.changeRoot);
    const crlfArtifacts = await discoverReviewedArtifacts(crlf.repositoryRoot, crlf.changeRoot);
    const original = await hashReviewedArtifacts(lfArtifacts);

    expect(await hashReviewedArtifacts(crlfArtifacts)).not.toBe(original);

    await writeFile(resolve(lf.changeRoot, "proposal.md"), "changed\n");
    expect(await hashReviewedArtifacts(lfArtifacts)).not.toBe(original);

    const renamed = lfArtifacts.map((artifact) =>
      artifact.relativePath.endsWith("proposal.md")
        ? { ...artifact, relativePath: artifact.relativePath.replace("proposal.md", "renamed.md") }
        : artifact
    );
    expect(await hashReviewedArtifacts(renamed)).not.toBe(original);
  });

  test("ignores runtime files outside the reviewed artifact set", async () => {
    const { repositoryRoot, changeRoot } = await fixture();
    const artifacts = await discoverReviewedArtifacts(repositoryRoot, changeRoot);
    const original = await hashReviewedArtifacts(artifacts);
    const runtimeRoot = resolve(repositoryRoot, ".fusion/runs/run-1");
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(resolve(runtimeRoot, "manifest.json"), '{"schemaVersion":1}\n');

    const rediscovered = await discoverReviewedArtifacts(repositoryRoot, changeRoot);

    expect(await hashReviewedArtifacts(rediscovered)).toBe(original);
  });
});