import { describe, expect, test } from "bun:test";
import { parseTaskDocument } from "../../src/execution/task-parser.ts";
import { validateTaskDocument } from "../../src/execution/task-schema.ts";
import { HarnessError } from "../../src/shared/errors.ts";

function document(metadata: string, checkboxId = "1.1") {
  return parseTaskDocument(`## 1. Foundation

- [ ] ${checkboxId} Implement parser

  \`\`\`yaml harness-task
  ${metadata.replaceAll("\n", "\n  ")}
  \`\`\`
`, "tasks.md");
}

const validMetadata = `id: "1.1"
dependsOn: []
role: builder
reads: ["src/execution/**"]
writes: ["src/../src/execution/**", 'tests\\execution\\**']
requirements: ["task-orchestration: Structured task execution metadata"]
scenarios: ["Task metadata is incomplete"]
verify: ["bun test tests/execution/task-schema.test.ts"]
manual: null`;

const references = {
  requirements: new Set(["task-orchestration: Structured task execution metadata"]),
  scenarios: new Set(["Task metadata is incomplete"]),
};

describe("task execution metadata", () => {
  test("validates fields and normalizes declared scopes", () => {
    const result = validateTaskDocument(document(validMetadata), references);

    expect(result.tasks[0]).toMatchObject({
      id: "1.1",
      role: "builder",
      reads: ["src/execution/**"],
      writes: ["src/execution/**", "tests/execution/**"],
      verify: ["bun test tests/execution/task-schema.test.ts"],
      manual: null,
    });
  });

  test("rejects checkbox and metadata identifier mismatch with a field path", () => {
    expect(() => validateTaskDocument(document(validMetadata.replace('id: "1.1"', 'id: "2.1"')), references)).toThrow(
      expect.objectContaining({
        code: "TASK_METADATA_INVALID",
        details: expect.objectContaining({ field: "id" }),
      }) as HarnessError,
    );
  });

  test("rejects escaping scopes and unknown requirement links before dispatch", () => {
    expect(() => validateTaskDocument(document(validMetadata.replace(
      'reads: ["src/execution/**"]',
      'reads: ["../outside/**"]',
    )), references)).toThrow(expect.objectContaining({
      code: "TASK_METADATA_INVALID",
      details: expect.objectContaining({ field: "reads.0" }),
    }) as HarnessError);

    expect(() => validateTaskDocument(document(validMetadata.replace(
      "task-orchestration: Structured task execution metadata",
      "unknown: Missing requirement",
    )), references)).toThrow(expect.objectContaining({
      code: "TASK_METADATA_INVALID",
      details: expect.objectContaining({ field: "requirements.0" }),
    }) as HarnessError);
  });

  test("requires a complete manual contract for manual roles", () => {
    const invalid = validMetadata
      .replace("role: builder", "role: manual")
      .replace("manual: null", `manual:
  category: authentication
  reason: Authentication is required`);

    expect(() => validateTaskDocument(document(invalid), references)).toThrow(
      expect.objectContaining({
        code: "TASK_METADATA_INVALID",
        details: expect.objectContaining({ field: "manual.instructions" }),
      }) as HarnessError,
    );
  });
});