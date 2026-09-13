import { resolve } from "node:path";
import {
  runFinalValidation,
  type FinalValidationResult,
  type RunFinalValidationOptions,
} from "../review/validator.ts";
import {
  createVerificationArtifact,
  writeVerificationArtifact,
  type CreateVerificationArtifactInput,
  type VerificationArtifact,
} from "../review/verification-artifact.ts";
import { HarnessError } from "../shared/errors.ts";

export type VerificationSummaryInput = Omit<
  CreateVerificationArtifactInput,
  "schemaVersion" | "runId" | "changeName" | "verifiedAt" | "result"
>;

export interface VerifyChangeInput {
  changeName: string;
  changeRoot: string;
  validation: RunFinalValidationOptions;
  summary: VerificationSummaryInput;
}

export interface VerifyChangeResult {
  validation: FinalValidationResult;
  artifact: VerificationArtifact;
  nextAction: "verify" | "finish";
}

export interface VerifyControllerDependencies {
  runValidation(options: RunFinalValidationOptions): Promise<FinalValidationResult>;
  writeArtifact(path: string, artifact: VerificationArtifact): Promise<void>;
}

const defaultDependencies: VerifyControllerDependencies = {
  runValidation: runFinalValidation,
  writeArtifact: writeVerificationArtifact,
};

function notReady(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("VERIFICATION_NOT_READY", message, details);
}

export async function verifyChange(
  input: VerifyChangeInput,
  overrides: Partial<VerifyControllerDependencies> = {},
): Promise<VerifyChangeResult> {
  if (input.validation.changeName !== input.changeName) {
    return notReady("Final validation belongs to a different change", {
      changeName: input.changeName,
      validationChangeName: input.validation.changeName,
    });
  }

  const dependencies = { ...defaultDependencies, ...overrides };
  const validation = await dependencies.runValidation(input.validation);
  if (validation.changeName !== input.changeName || validation.runId !== input.validation.runId) {
    return notReady("Final validation returned a different change or run identity", {
      changeName: input.changeName,
      runId: input.validation.runId,
      validationChangeName: validation.changeName,
      validationRunId: validation.runId,
    });
  }
  if (
    (validation.artifactDigest !== null && validation.artifactDigest !== input.summary.artifactDigest) ||
    (validation.sourceDigest !== null && validation.sourceDigest !== input.summary.sourceDigest)
  ) {
    return notReady("Verification evidence digests differ from final validation", {
      validationArtifactDigest: validation.artifactDigest,
      evidenceArtifactDigest: input.summary.artifactDigest,
      validationSourceDigest: validation.sourceDigest,
      evidenceSourceDigest: input.summary.sourceDigest,
    });
  }
  if (validation.result === "PASS" &&
      (validation.artifactDigest === null || validation.sourceDigest === null)) {
    return notReady("Passing final validation did not produce freshness digests", {
      artifactDigest: validation.artifactDigest,
      sourceDigest: validation.sourceDigest,
    });
  }

  const artifact = createVerificationArtifact({
    schemaVersion: 1,
    runId: validation.runId,
    changeName: validation.changeName,
    verifiedAt: validation.validatedAt,
    result: validation.result,
    ...input.summary,
  });
  await dependencies.writeArtifact(resolve(input.changeRoot, "verification.md"), artifact);

  return {
    validation,
    artifact,
    nextAction: validation.result === "PASS" ? "finish" : "verify",
  };
}