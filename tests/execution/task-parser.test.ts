import { describe, expect, test } from "bun:test";
import { parseTaskDocument } from "../../src/execution/task-parser.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const metadata = `\`\`\`yaml harness-task
id: "1.1"
dependsOn: []
role: builder
writes: ["src/**"]
verify: ["bun test"]
manual: null
\`\`\``;

describe("OpenSpec task Markdown parser", () => {
  test("parses phase headings, checkboxes, adjacent metadata, and source locations", () => {
    const document = `# Tasks

## 1. Foundation

- [ ] 1.1 Implement parser

  ${metadata.replaceAll("\n", "\n  ")}

## Phase 2 - Verification

- [x] 2.1 Verify behavior

  \`\`\`yaml harness-task
  id: "2.1"
  dependsOn: ["1.1"]
  role: validator
  writes: []
  verify: ["bun test tests/execution"]
  manual: null
  \`\`\`
`;

    const result = parseTaskDocument(document, "tasks.md");

    expect(result.phases.map((phase) => [phase.number, phase.title])).toEqual([
      [1, "Foundation"],
      [2, "Verification"],
    ]);
    expect(result.tasks.map((task) => ({ id: task.checkboxId, checked: task.checked }))).toEqual([
      { id: "1.1", checked: false },
      { id: "2.1", checked: true },
    ]);
    expect(result.tasks[0]?.metadata).toMatchObject({ id: "1.1", role: "builder" });
    expect(result.tasks[0]?.location).toMatchObject({
      path: "tasks.md",
      checkbox: { start: { line: 5, column: 1 } },
      metadata: { start: { line: 7, column: 3 } },
    });
  });

  test("rejects a metadata fence that is not adjacent to its checkbox", () => {
    const document = `## 1. Foundation

- [ ] 1.1 Implement parser

  Additional prose breaks the association.

  ${metadata.replaceAll("\n", "\n  ")}
`;

    expect(() => parseTaskDocument(document, "tasks.md")).toThrow(
      expect.objectContaining({ code: "TASK_DOCUMENT_INVALID" }) as HarnessError,
    );
  });

  test("rejects duplicate metadata blocks for one checkbox", () => {
    const indented = metadata.replaceAll("\n", "\n  ");
    const document = `## 1. Foundation

- [ ] 1.1 Implement parser

  ${indented}

  ${indented}
`;

    expect(() => parseTaskDocument(document, "tasks.md")).toThrow(
      expect.objectContaining({ code: "TASK_DOCUMENT_INVALID" }) as HarnessError,
    );
  });

  test("does not treat checkboxes inside fenced code as executable tasks", () => {
    const document = `## 1. Foundation

\`\`\`markdown
- [ ] 9.9 Example only
\`\`\`
`;

    expect(parseTaskDocument(document, "tasks.md").tasks).toEqual([]);
  });
});