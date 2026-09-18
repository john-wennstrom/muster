import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ChangeSnapshot } from "../../src/controller/change-snapshot.ts";
import { finishChange } from "../../src/controller/finish.ts";
import { verifyChange } from "../../src/controller/verify.ts";
import { dispatchChangeCommand } from "../../src/runtime/change-command.ts";
import type { OpenSpecArchive } from "../../src/openspec/protocol.ts";
import type { FinalValidationResult } from "../../src/review/validator.ts";
import {
  createVerificationArtifact,
  type CreateVerificationArtifactInput,
  type VerificationArtifact,
} from "../../src/review/verification-artifact.ts";

const timestamp = "2026-09-12T12:00:00.000Z";
const artifactDigest = "a".repeat(64);
const sourceDigest = "b".repeat(64);

function validation(result: "PASS" | "FAIL" = "PASS"): FinalValidationResult {
  const gates = [
    "openspec",
    "tasks",
    "evidence",
    "tests",
    "findings",
    "design",
    "freshness",
    "reports",
    "repository",
  ] as const;
  return {
    schemaVersion: 1,
    runId: "run-1",
    changeName: "add-search",
    sessionId: "validator-session",
    validatedAt: timestamp,
    access: "read",
    result,
    readiness: result === "PASS" ? "READY_TO_FINISH" : "BLOCKED",
    artifactDigest,
    sourceDigest,
    checks: gates.map((gate) => ({
      gate,
      status: result === "FAIL" && gate === "tests" ? "FAIL" : "PASS",
      summary: result === "FAIL" && gate === "tests" ? "full suite failed" : `${gate} checks passed`,
      evidence: [],
    })),
    blockingReasons: result === "FAIL" ? ["tests: full suite failed"] : [],
  };
}

function summary(): Omit<
  CreateVerificationArtifactInput,
  "schemaVersion" | "runId" | "changeName" | "verifiedAt" | "result"
> {
  return {
    model: "openai/validator",
    artifactDigest,
    sourceDigest,
    repositoryState: { kind: "diff", identity: "sha256:current-diff" },
    commands: [{ command: "bun test", exitCode: 0, evidenceLinks: [] }],
    requirementEvidence: [{
      requirement: "review-and-verification: Explicit finish boundary",
      scenario: "Verification succeeds",
      evidenceLinks: [{ label: "focused test", href: "tests/commands/verify-finish.test.ts" }],
    }],
    findings: [],
    deviations: [],
    warnings: [],
  };
}

function passingArtifact(): VerificationArtifact {
  return createVerificationArtifact({
    schemaVersion: 1,
    runId: "run-1",
    changeName: "add-search",
    verifiedAt: timestamp,
    result: "PASS",
    ...summary(),
  });
}

const archiveResult: OpenSpecArchive = {
  archive: {
    change: "add-search",
    archivedAs: "2026-09-12-add-search",
    path: "/repo/openspec/changes/archive/2026-09-12-add-search",
    specsUpdated: ["search"],
  },
  root: { path: "/repo", source: "nearest" },
};

function snapshot(lifecycle: "VERIFYING" | "VERIFIED"): ChangeSnapshot {
  return {
    changeName: "add-search",
    lifecycle,
    capturedAt: timestamp,
    observations: { openSpec: timestamp, repository: timestamp },
    digests: { artifact: artifactDigest, source: sourceDigest, head: "c", index: "d", diff: "e" },
    freshness: { review: "current", validation: lifecycle === "VERIFIED" ? "current" : "missing" },
    taskStates: { "1.1": true },
    pendingCheckpointIds: [],
    discrepancies: [],
  };
}

describe("change verify and finish commands", () => {
  test("verify runs final validation and writes evidence without archive or Git lifecycle effects", async () => {
    const events: string[] = [];
    let written: VerificationArtifact | undefined;

    const result = await verifyChange({
      changeName: "add-search",
      changeRoot: "/repo/openspec/changes/add-search",
      validation: {
        runId: "run-1",
        changeName: "add-search",
        sessionsRoot: "/repo/.fusion/sessions",
        dependencies: {} as never,
      },
      summary: summary(),
    }, {
      runValidation: async () => {
        events.push("validate");
        return validation();
      },
      writeArtifact: async (path, artifact) => {
        events.push(`write:${path}`);
        written = artifact;
      },
    });

    expect(events).toEqual([
      "validate",
      `write:${resolve("/repo/openspec/changes/add-search/verification.md")}`,
    ]);
    expect(written).toMatchObject({ result: "PASS", artifactDigest, sourceDigest });
    expect(result.nextAction).toBe("finish");
  });

  test("verify persists failed evidence and remains in verification", async () => {
    let written: VerificationArtifact | undefined;
    const result = await verifyChange({
      changeName: "add-search",
      changeRoot: "/repo/openspec/changes/add-search",
      validation: {
        runId: "run-1",
        changeName: "add-search",
        sessionsRoot: "/repo/.fusion/sessions",
        dependencies: {} as never,
      },
      summary: summary(),
    }, {
      runValidation: async () => validation("FAIL"),
      writeArtifact: async (_path, artifact) => { written = artifact; },
    });

    expect(written?.result).toBe("FAIL");
    expect(result.nextAction).toBe("verify");
  });

  test("finish delegates only archive after source and artifact freshness are rechecked", async () => {
    const events: string[] = [];
    const result = await finishChange({
      changeName: "add-search",
      changeRoot: "/repo/openspec/changes/add-search",
    }, {
      readVerification: async () => {
        events.push("read-verification");
        return passingArtifact();
      },
      readCurrentDigests: async () => {
        events.push("read-digests");
        return { artifactDigest, sourceDigest };
      },
      archive: async (changeName) => {
        events.push(`archive:${changeName}`);
        return archiveResult;
      },
    });

    expect(events).toEqual(["read-verification", "read-digests", "archive:add-search"]);
    expect(result.archive).toEqual(archiveResult);
  });

  test("finish refuses failed or stale verification before archive", async () => {
    let archives = 0;
    const dependencies = {
      readVerification: async () => passingArtifact(),
      readCurrentDigests: async () => ({ artifactDigest, sourceDigest }),
      archive: async () => {
        archives++;
        return archiveResult;
      },
    };

    await expect(finishChange({
      changeName: "add-search",
      changeRoot: "/repo/openspec/changes/add-search",
    }, {
      ...dependencies,
      readVerification: async () => ({ ...passingArtifact(), result: "FAIL" }),
    })).rejects.toMatchObject({ code: "VERIFICATION_NOT_READY" });

    await expect(finishChange({
      changeName: "add-search",
      changeRoot: "/repo/openspec/changes/add-search",
    }, {
      ...dependencies,
      readCurrentDigests: async () => ({ artifactDigest, sourceDigest: "c".repeat(64) }),
    })).rejects.toMatchObject({ code: "VERIFICATION_NOT_READY" });

    await expect(finishChange({
      changeName: "add-search",
      changeRoot: "/repo/openspec/changes/add-search",
    }, {
      ...dependencies,
      readCurrentDigests: async () => ({ artifactDigest: "d".repeat(64), sourceDigest }),
    })).rejects.toMatchObject({ code: "VERIFICATION_NOT_READY" });

    expect(archives).toBe(0);
  });

  test("dispatch keeps verify and finish as separate explicit commands", async () => {
    const handled: string[] = [];
    const dispatch = (raw: string, lifecycle: "VERIFYING" | "VERIFIED") => dispatchChangeCommand(raw, {
      ui: { notify: () => undefined },
    }, {
      resolveChangeName: async (explicit) => explicit ?? null,
      loadSnapshot: async () => snapshot(lifecycle),
      handlers: {
        verify: async () => { handled.push("verify"); },
        finish: async () => { handled.push("finish"); },
      },
    });

    await dispatch("verify add-search", "VERIFYING");
    expect(handled).toEqual(["verify"]);
    await dispatch("finish add-search", "VERIFIED");
    expect(handled).toEqual(["verify", "finish"]);
  });
});
