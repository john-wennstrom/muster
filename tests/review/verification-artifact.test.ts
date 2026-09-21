import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createVerificationArtifact,
  parseVerificationArtifact,
  renderVerificationArtifact,
  writeVerificationArtifact,
} from "../../src/review/verification-artifact.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function passingArtifact() {
  return createVerificationArtifact({
    schemaVersion: 1,
    runId: "run-12",
    changeName: "add-verification",
    verifiedAt: "2026-09-12T12:00:00.000Z",
    model: "openai/validator",
    artifactDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64),
    repositoryState: { kind: "diff", identity: "sha256:cafebabe" },
    result: "PASS",
    commands: [{
      command: "bun test tests/review/verification-artifact.test.ts",
      exitCode: 0,
      evidenceLinks: [{
        label: "focused test output",
        href: ".fusion/runs/run-12/evidence/verification-artifact.log",
      }],
    }],
    requirementEvidence: [{
      requirement: "review-and-verification: Durable verification summary",
      scenario: "Verification passes",
      evidenceLinks: [{
        label: "artifact test",
        href: "tests/review/verification-artifact.test.ts",
      }],
    }],
    findings: [{
      severity: "WARNING",
      status: "RESOLVED",
      summary: "The template lacked a schema version.",
      evidenceLinks: [{ label: "updated template", href: "schemas/fusion-driven/templates/verification.md" }],
    }],
    deviations: [{
      summary: "No controller integration in this task.",
      rationale: "Command integration belongs to task 12.3.",
      evidenceLinks: [{ label: "task contract", href: "openspec/changes/build-openspec-multi-agent-harness/tasks.md" }],
    }],
    warnings: [{
      summary: "Verification must be refreshed when either digest changes.",
      evidenceLinks: [{ label: "verification spec", href: "openspec/changes/build-openspec-multi-agent-harness/specs/review-and-verification/spec.md" }],
    }],
  });
}

describe("verification artifact", () => {
  test("round trips reproducible evidence and digest-bound status", () => {
    const artifact = passingArtifact();
    const markdown = renderVerificationArtifact(artifact);

    expect(parseVerificationArtifact(markdown, "verification.md")).toEqual(artifact);
    expect(markdown).toContain("bun test tests/review/verification-artifact.test.ts");
    expect(markdown).toContain(artifact.artifactDigest);
    expect(markdown).toContain(artifact.sourceDigest);
    expect(markdown).not.toContain("<!--");
    expect(markdown).not.toContain("transcript");
  });

  test("derives command outcomes and prevents an invalid passing summary", () => {
    const passing = passingArtifact();
    expect(passing.commands[0]?.outcome).toBe("PASS");

    expect(() => createVerificationArtifact({
      ...passing,
      result: "PASS",
      commands: [{
        command: "bun test",
        exitCode: 1,
        evidenceLinks: [],
      }],
    })).toThrow(expect.objectContaining({ code: "VERIFICATION_ARTIFACT_INVALID" }) as HarnessError);

    expect(() => createVerificationArtifact({
      ...passing,
      findings: [{
        severity: "BLOCKING",
        status: "UNRESOLVED",
        summary: "Required full suite failed.",
        evidenceLinks: [],
      }],
      commands: passing.commands,
    })).toThrow(expect.objectContaining({ code: "VERIFICATION_ARTIFACT_INVALID" }) as HarnessError);
  });

  test("strict parsing rejects raw transcripts and unsupported fields", () => {
    const markdown = renderVerificationArtifact(passingArtifact());
    const withTranscriptField = markdown.replace(
      '"command": "bun test tests/review/verification-artifact.test.ts",',
      '"command": "bun test tests/review/verification-artifact.test.ts",\n    "transcript": "raw model output",',
    );
    expect(() => parseVerificationArtifact(withTranscriptField, "verification.md")).toThrow(
      expect.objectContaining({ code: "VERIFICATION_ARTIFACT_INVALID" }) as HarnessError,
    );

    const withTranscriptSection = `${markdown}## Transcript\n\nraw model output\n`;
    expect(() => parseVerificationArtifact(withTranscriptSection, "verification.md")).toThrow(
      expect.objectContaining({ code: "VERIFICATION_ARTIFACT_INVALID" }) as HarnessError,
    );
  });

  test("atomically preserves the previous summary when replacement is interrupted", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-verification-artifact-"));
    temporaryDirectories.push(root);
    const path = resolve(root, "verification.md");
    const previous = passingArtifact();
    await writeVerificationArtifact(path, previous);

    await expect(writeVerificationArtifact(path, {
      ...previous,
      result: "FAIL",
      warnings: [{ summary: "Replacement was interrupted.", evidenceLinks: [] }],
    }, {
      beforeRename: () => {
        throw new Error("injected interruption");
      },
    })).rejects.toThrow("injected interruption");

    expect(parseVerificationArtifact(await readFile(path, "utf8"), path)).toEqual(previous);
  });
});

describe("reused command evidence", () => {
  test("a reused command keeps its source digest through render and parse, and an ordinary one has none", () => {
    const base = passingArtifact();
    const artifact = createVerificationArtifact({
      ...base,
      commands: [
        { command: "bun test a", exitCode: 0, reused: { sourceDigest: "c".repeat(64) }, evidenceLinks: [] },
        { command: "bun test", exitCode: 0, evidenceLinks: [] },
      ],
    });
    const parsed = parseVerificationArtifact(renderVerificationArtifact(artifact), "verification.md");
    expect(parsed.commands[0]!.reused).toEqual({ sourceDigest: "c".repeat(64) });
    expect(parsed.commands[1]!.reused).toBeUndefined();
  });

  test("a reused entry needs a well-formed digest", () => {
    expect(() => createVerificationArtifact({
      ...passingArtifact(),
      commands: [{ command: "bun test a", exitCode: 0, reused: { sourceDigest: "nope" }, evidenceLinks: [] }],
    })).toThrow(HarnessError);
  });
});
