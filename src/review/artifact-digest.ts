import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HarnessError } from "../shared/errors.ts";

export interface ReviewedArtifact {
  absolutePath: string;
  relativePath: string;
}

function invalidArtifact(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("REVIEW_ARTIFACT_INVALID", message, details);
}

function toRepositoryRelativePath(repositoryRoot: string, path: string): string {
  const value = relative(repositoryRoot, path);
  if (!value || isAbsolute(value) || value.split(sep).includes("..")) {
    invalidArtifact("Reviewed artifact is outside the repository root", {
      repositoryRoot,
      path,
    });
  }
  return value.split(sep).join("/");
}

async function requireRegularFile(path: string): Promise<void> {
  let status;
  try {
    status = await lstat(path);
  } catch (cause) {
    invalidArtifact("Required reviewed artifact is missing", { path, cause });
  }
  if (!status.isFile()) {
    invalidArtifact("Reviewed artifact must be a regular file", { path });
  }
}

async function discoverMarkdownFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    invalidArtifact("Reviewed specification directory is missing", { directory, cause });
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await discoverMarkdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    } else if (entry.isSymbolicLink()) {
      invalidArtifact("Reviewed artifacts may not be symbolic links", { path });
    }
  }
  return files;
}

export async function discoverReviewedArtifacts(
  repositoryRoot: string,
  changeRoot: string,
): Promise<ReviewedArtifact[]> {
  const canonicalRepositoryRoot = resolve(repositoryRoot);
  const canonicalChangeRoot = resolve(changeRoot);
  toRepositoryRelativePath(canonicalRepositoryRoot, canonicalChangeRoot);

  const requiredPaths = ["proposal.md", "design.md", "tasks.md"].map((name) =>
    resolve(canonicalChangeRoot, name)
  );
  await Promise.all(requiredPaths.map(requireRegularFile));
  const specificationPaths = await discoverMarkdownFiles(resolve(canonicalChangeRoot, "specs"));
  if (specificationPaths.length === 0) {
    invalidArtifact("Reviewed artifact set contains no delta specifications", {
      changeRoot: canonicalChangeRoot,
    });
  }

  return [...requiredPaths, ...specificationPaths]
    .map((absolutePath) => ({
      absolutePath,
      relativePath: toRepositoryRelativePath(canonicalRepositoryRoot, absolutePath),
    }))
    .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
}

function lengthFrame(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) {
    invalidArtifact("Reviewed artifact length is invalid", { length });
  }
  const frame = Buffer.allocUnsafe(8);
  frame.writeBigUInt64BE(BigInt(length));
  return frame;
}

export async function hashReviewedArtifacts(
  artifacts: readonly ReviewedArtifact[],
): Promise<string> {
  const ordered = [...artifacts].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  );
  const seen = new Set<string>();
  const hash = createHash("sha256");

  for (const artifact of ordered) {
    if (
      !artifact.relativePath ||
      isAbsolute(artifact.relativePath) ||
      artifact.relativePath.includes("\\") ||
      artifact.relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      seen.has(artifact.relativePath)
    ) {
      invalidArtifact("Reviewed artifact path is not unique canonical POSIX relative form", {
        relativePath: artifact.relativePath,
      });
    }
    seen.add(artifact.relativePath);

    const pathBytes = Buffer.from(artifact.relativePath, "utf8");
    const file = await open(artifact.absolutePath, "r");
    try {
      const before = await file.stat();
      if (!before.isFile()) {
        invalidArtifact("Reviewed artifact must be a regular file", {
          path: artifact.absolutePath,
        });
      }
      hash.update(lengthFrame(pathBytes.byteLength));
      hash.update(pathBytes);
      hash.update(lengthFrame(before.size));

      let bytesRead = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        const bytes = chunk as Buffer;
        bytesRead += bytes.byteLength;
        hash.update(bytes);
      }
      const after = await file.stat();
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        invalidArtifact("Reviewed artifact changed while its digest was calculated", {
          path: artifact.absolutePath,
        });
      }
    } finally {
      await file.close();
    }
  }

  return hash.digest("hex");
}