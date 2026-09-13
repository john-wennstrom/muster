import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { HarnessError } from "../shared/errors.ts";

const singleLine = z.string().min(1).refine((value) => !/[\r\n]/.test(value), {
  message: "Expected a single line",
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);

const evidenceLinkSchema = z.object({
  label: singleLine,
  href: singleLine,
}).strict();

const verificationCommandSchema = z.object({
  command: singleLine,
  exitCode: z.number().int(),
  outcome: z.enum(["PASS", "FAIL"]),
  evidenceLinks: z.array(evidenceLinkSchema),
}).strict().superRefine((command, context) => {
  const expected = command.exitCode === 0 ? "PASS" : "FAIL";
  if (command.outcome !== expected) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: `Expected ${expected} for exit code ${command.exitCode}`,
    });
  }
});

const requirementEvidenceSchema = z.object({
  requirement: singleLine,
  scenario: singleLine,
  evidenceLinks: z.array(evidenceLinkSchema).min(1),
}).strict();

const verificationFindingSchema = z.object({
  severity: z.enum(["BLOCKING", "WARNING"]),
  status: z.enum(["RESOLVED", "UNRESOLVED"]),
  summary: singleLine,
  evidenceLinks: z.array(evidenceLinkSchema),
}).strict();

const verificationDeviationSchema = z.object({
  summary: singleLine,
  rationale: singleLine,
  evidenceLinks: z.array(evidenceLinkSchema),
}).strict();

const verificationWarningSchema = z.object({
  summary: singleLine,
  evidenceLinks: z.array(evidenceLinkSchema),
}).strict();

export const verificationArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  runId: singleLine,
  changeName: singleLine,
  verifiedAt: z.string().datetime({ offset: true }),
  model: singleLine,
  artifactDigest: digest,
  sourceDigest: digest,
  repositoryState: z.object({
    kind: z.enum(["commit", "diff"]),
    identity: singleLine,
  }).strict(),
  result: z.enum(["PASS", "FAIL"]),
  commands: z.array(verificationCommandSchema).min(1),
  requirementEvidence: z.array(requirementEvidenceSchema).min(1),
  findings: z.array(verificationFindingSchema),
  deviations: z.array(verificationDeviationSchema),
  warnings: z.array(verificationWarningSchema),
}).strict().superRefine((artifact, context) => {
  if (artifact.result !== "PASS") return;
  if (artifact.commands.some((command) => command.outcome === "FAIL")) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: "PASS cannot include failed commands",
    });
  }
  if (artifact.findings.some((finding) =>
    finding.severity === "BLOCKING" && finding.status === "UNRESOLVED"
  )) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: "PASS cannot include unresolved blocking findings",
    });
  }
});

export type VerificationArtifact = z.infer<typeof verificationArtifactSchema>;
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

export interface CreateVerificationArtifactInput
  extends Omit<VerificationArtifact, "commands"> {
  commands: readonly Omit<VerificationCommand, "outcome">[];
}

export interface VerificationArtifactWriteHooks {
  beforeRename?: (temporaryPath: string, targetPath: string) => Promise<void> | void;
}

function invalidVerification(
  message: string,
  path: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): never {
  throw new HarnessError(
    "VERIFICATION_ARTIFACT_INVALID",
    `${message}: ${path}`,
    { path, ...details },
    cause === undefined ? undefined : { cause },
  );
}

function validateVerification(payload: unknown, path: string): VerificationArtifact {
  const result = verificationArtifactSchema.safeParse(payload);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path.map(String).join(".") || "<root>",
  }));
  return invalidVerification(
    `Verification artifact is incompatible at ${issues[0]?.path ?? "<root>"}`,
    path,
    { issues },
  );
}

export function createVerificationArtifact(
  input: CreateVerificationArtifactInput,
): VerificationArtifact {
  return validateVerification({
    ...input,
    commands: input.commands.map((command) => ({
      ...command,
      outcome: command.exitCode === 0 ? "PASS" : "FAIL",
    })),
  }, "verification.md");
}

const sectionDefinitions = [
  ["## Commands", "commands"],
  ["## Requirement Evidence", "requirementEvidence"],
  ["## Findings", "findings"],
  ["## Deviations", "deviations"],
  ["## Warnings", "warnings"],
] as const;

function renderJsonSection(heading: string, value: unknown): string[] {
  return [heading, "", "```json", JSON.stringify(value, null, 2), "```", ""];
}

export function renderVerificationArtifact(artifact: VerificationArtifact): string {
  const valid = validateVerification(artifact, "verification.md");
  return [
    "# Verification",
    "",
    `- Schema version: \`${valid.schemaVersion}\``,
    `- Run ID: \`${valid.runId}\``,
    `- Change: \`${valid.changeName}\``,
    `- Verified at: \`${valid.verifiedAt}\``,
    `- Model: \`${valid.model}\``,
    `- Artifact digest: \`${valid.artifactDigest}\``,
    `- Source digest: \`${valid.sourceDigest}\``,
    `- Repository state kind: \`${valid.repositoryState.kind}\``,
    `- Repository state identity: \`${valid.repositoryState.identity}\``,
    `- Result: \`${valid.result}\``,
    "",
    ...sectionDefinitions.flatMap(([heading, field]) => renderJsonSection(heading, valid[field])),
  ].join("\n");
}

function expectedLine(lines: readonly string[], index: number, value: string, path: string): number {
  if (lines[index] !== value) {
    return invalidVerification(`Expected ${JSON.stringify(value)} at line ${index + 1}`, path);
  }
  return index + 1;
}

function metadataValue(line: string | undefined, label: string, path: string): string {
  const prefix = `- ${label}: \``;
  if (!line?.startsWith(prefix) || !line.endsWith("`") || line.length === prefix.length + 1) {
    return invalidVerification(`Expected one backtick-delimited ${label} field`, path);
  }
  return line.slice(prefix.length, -1);
}

function parseJsonSection(
  lines: readonly string[],
  start: number,
  heading: string,
  path: string,
): { value: unknown; next: number } {
  let index = expectedLine(lines, start, heading, path);
  index = expectedLine(lines, index, "", path);
  index = expectedLine(lines, index, "```json", path);
  const closing = lines.indexOf("```", index);
  if (closing === -1) return invalidVerification(`Expected closing fence for ${heading}`, path);
  let value: unknown;
  try {
    value = JSON.parse(lines.slice(index, closing).join("\n"));
  } catch (cause) {
    return invalidVerification(`${heading} is not valid JSON`, path, { heading }, cause);
  }
  return { value, next: expectedLine(lines, closing + 1, "", path) };
}

export function parseVerificationArtifact(contents: string, path: string): VerificationArtifact {
  const lines = contents.replace(/\r\n/g, "\n").split("\n");
  let index = expectedLine(lines, 0, "# Verification", path);
  index = expectedLine(lines, index, "", path);
  const schemaVersion = Number(metadataValue(lines[index++], "Schema version", path));
  const runId = metadataValue(lines[index++], "Run ID", path);
  const changeName = metadataValue(lines[index++], "Change", path);
  const verifiedAt = metadataValue(lines[index++], "Verified at", path);
  const model = metadataValue(lines[index++], "Model", path);
  const artifactDigest = metadataValue(lines[index++], "Artifact digest", path);
  const sourceDigest = metadataValue(lines[index++], "Source digest", path);
  const repositoryStateKind = metadataValue(lines[index++], "Repository state kind", path);
  const repositoryStateIdentity = metadataValue(lines[index++], "Repository state identity", path);
  const result = metadataValue(lines[index++], "Result", path);
  index = expectedLine(lines, index, "", path);

  const sections: Record<string, unknown> = {};
  for (const [heading, field] of sectionDefinitions) {
    const parsed = parseJsonSection(lines, index, heading, path);
    sections[field] = parsed.value;
    index = parsed.next;
  }
  if (index !== lines.length) {
    return invalidVerification(`Unsupported content at line ${index + 1}`, path);
  }

  return validateVerification({
    schemaVersion,
    runId,
    changeName,
    verifiedAt,
    model,
    artifactDigest,
    sourceDigest,
    repositoryState: {
      kind: repositoryStateKind,
      identity: repositoryStateIdentity,
    },
    result,
    ...sections,
  }, path);
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      throw error;
    }
  }
}

export async function writeVerificationArtifact(
  path: string,
  artifact: VerificationArtifact,
  hooks: VerificationArtifactWriteHooks = {},
): Promise<void> {
  const targetPath = resolve(path);
  const targetDirectory = dirname(targetPath);
  const temporaryPath = resolve(
    targetDirectory,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(targetDirectory, { recursive: true });

  let file;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(renderVerificationArtifact(artifact), "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await hooks.beforeRename?.(temporaryPath, targetPath);
    await rename(temporaryPath, targetPath);
    await syncDirectory(targetDirectory);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}