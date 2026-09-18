import { readFile } from "node:fs/promises";
import { parseTaskDocument } from "./task-parser.ts";
import { validateTaskDocument, type ValidatedTaskDocument } from "./task-schema.ts";

export interface LoadedTaskDocument {
  contents: string;
  document: ValidatedTaskDocument;
}

/**
 * Validates a tasks.md against the requirement and scenario identifiers the document
 * itself references, which is the only reference index available before specs are read.
 */
export function validateAgainstOwnReferences(
  contents: string,
  tasksPath: string,
): ValidatedTaskDocument {
  const parsed = parseTaskDocument(contents, tasksPath);
  const requirements = new Set<string>();
  const scenarios = new Set<string>();
  for (const task of parsed.tasks) {
    const metadata = task.metadata as { requirements?: unknown; scenarios?: unknown };
    if (Array.isArray(metadata.requirements)) {
      for (const value of metadata.requirements) if (typeof value === "string") requirements.add(value);
    }
    if (Array.isArray(metadata.scenarios)) {
      for (const value of metadata.scenarios) if (typeof value === "string") scenarios.add(value);
    }
  }
  return validateTaskDocument(parsed, { requirements, scenarios });
}

export async function loadValidatedTaskDocument(tasksPath: string): Promise<LoadedTaskDocument> {
  const contents = await readFile(tasksPath, "utf8");
  return { contents, document: validateAgainstOwnReferences(contents, tasksPath) };
}
