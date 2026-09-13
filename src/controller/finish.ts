import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { OpenSpecArchive } from "../openspec/protocol.ts";
import {
  parseVerificationArtifact,
  type VerificationArtifact,
} from "../review/verification-artifact.ts";
import { HarnessError } from "../shared/errors.ts";

export interface FinishChangeInput {
  changeName: string;
  changeRoot: string;
}

export interface VerificationFreshness {
  artifactDigest: string;
  sourceDigest: string;
}

export interface FinishControllerDependencies {
  readVerification(path: string): Promise<VerificationArtifact>;
  readCurrentDigests(changeName: string): Promise<VerificationFreshness>;
  archive(changeName: string): Promise<OpenSpecArchive>;
}

export interface FinishChangeResult {
  verification: VerificationArtifact;
  archive: OpenSpecArchive;
}

async function readVerification(path: string): Promise<VerificationArtifact> {
  return parseVerificationArtifact(await readFile(path, "utf8"), path);
}

function notReady(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("VERIFICATION_NOT_READY", message, details);
}

export async function finishChange(
  input: FinishChangeInput,
  dependencies: Omit<FinishControllerDependencies, "readVerification"> &
    Partial<Pick<FinishControllerDependencies, "readVerification">>,
): Promise<FinishChangeResult> {
  const readArtifact = dependencies.readVerification ?? readVerification;
  const verificationPath = resolve(input.changeRoot, "verification.md");
  const verification = await readArtifact(verificationPath);
  if (verification.changeName !== input.changeName) {
    return notReady("Verification evidence belongs to a different change", {
      changeName: input.changeName,
      verificationChangeName: verification.changeName,
      verificationPath,
    });
  }
  if (verification.result !== "PASS") {
    return notReady("The latest verification did not pass", {
      changeName: input.changeName,
      result: verification.result,
    });
  }

  const current = await dependencies.readCurrentDigests(input.changeName);
  const staleInputs: string[] = [];
  if (verification.artifactDigest !== current.artifactDigest) staleInputs.push("OpenSpec artifacts");
  if (verification.sourceDigest !== current.sourceDigest) staleInputs.push("source");
  if (staleInputs.length > 0) {
    return notReady(
      `Verification is stale for current ${staleInputs.join(" and ")}`,
      {
        changeName: input.changeName,
        verifiedArtifactDigest: verification.artifactDigest,
        currentArtifactDigest: current.artifactDigest,
        verifiedSourceDigest: verification.sourceDigest,
        currentSourceDigest: current.sourceDigest,
      },
    );
  }

  const archive = await dependencies.archive(input.changeName);
  return { verification, archive };
}