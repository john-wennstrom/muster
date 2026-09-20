import { describe, expect, test } from "bun:test";
import {
  TASK_QUALITY_MAX_TASKS,
  TASK_QUALITY_SUMMARY_BYTES,
  buildTaskQualityInput,
  taskDefinitionDigest,
  type TaskQualityBundleArtifact,
} from "../../src/controller/task-quality.ts";
import { taskQualityState } from "../../src/judgment/gates.ts";

interface TaskSpec {
  id: string;
  description?: string;
  dependsOn?: string[];
  writes?: string[];
  verify?: string[];
  checked?: boolean;
}

function taskBlock(task: TaskSpec): string {
  const yaml = [
    `id: "${task.id}"`,
    `dependsOn: ${JSON.stringify(task.dependsOn ?? [])}`,
    "role: builder",
    "reads: []",
    `writes: ${JSON.stringify(task.writes ?? ["src/a.ts"])}`,
    `requirements: ["cap: Requirement one"]`,
    `scenarios: ["Scenario one"]`,
    `verify: ${JSON.stringify(task.verify ?? ["bun test"])}`,
    "manual: null",
  ].map((line) => `  ${line}`).join("\n");
  return `- [${task.checked ? "x" : " "}] ${task.id} ${task.description ?? `Do task ${task.id}`}\n\n  \`\`\`yaml harness-task\n${yaml}\n  \`\`\`\n`;
}

const tasksMd = (tasks: readonly TaskSpec[]): string => `## 1. Work\n\n${tasks.map(taskBlock).join("\n")}`;

const SPEC = [
  "## ADDED Requirements",
  "",
  "### Requirement: Requirement one",
  "The system SHALL do the first thing.",
  "",
  "#### Scenario: Scenario one",
  "- **WHEN** it happens",
  "- **THEN** the thing is done",
  "",
  "### Requirement: Requirement two",
  "The system SHALL do the second thing.",
  "",
  "#### Scenario: Scenario two",
  "- **THEN** the other thing is done",
].join("\n");

function bundle(tasks: string, extra: Partial<Record<string, string>> = {}): TaskQualityBundleArtifact[] {
  return [
    { path: "proposal.md", content: extra.proposal ?? "## Why\n\nBecause." },
    { path: "design.md", content: "# Design" },
    { path: "specs/cap/spec.md", content: extra.spec ?? SPEC },
    { path: "tasks.md", content: tasks },
  ];
}

const twoTasks = [{ id: "1.1" }, { id: "1.2", dependsOn: ["1.1"] }];

describe("buildTaskQualityInput", () => {
  test("builds the state from tasks, requirements, scenarios, and the proposal", () => {
    const result = buildTaskQualityInput(bundle(tasksMd(twoTasks)));
    if (!result.ok) throw new Error(result.reason);
    expect(result.taskIds).toEqual(["1.1", "1.2"]);
    expect(result.input.summary).toBe("## Why\n\nBecause.");
    expect(result.input.tasks[1]).toEqual({
      id: "1.2",
      description: "Do task 1.2",
      dependsOn: ["1.1"],
      reads: [],
      writes: ["src/a.ts"],
      verify: ["bun test"],
    });
    expect(result.input.requirements.map((requirement) => requirement.name)).toEqual(["Requirement one", "Requirement two"]);
    expect(result.input.requirements[0]!.text).toBe("The system SHALL do the first thing.");
    expect(result.input.requirements[0]!.scenarios).toEqual([
      { name: "Scenario one", text: "- **WHEN** it happens\n- **THEN** the thing is done" },
    ]);
  });

  test("skips a task list that does not parse or validate", () => {
    expect(buildTaskQualityInput(bundle("## 1. Work\n\n- [ ] 1.1 No metadata block\n"))).toEqual({ ok: false, reason: "invalid_tasks" });
    expect(buildTaskQualityInput(bundle(tasksMd([{ id: "1.1", verify: [] }])))).toEqual({ ok: false, reason: "invalid_tasks" });
    expect(buildTaskQualityInput(bundle(tasksMd([{ id: "1.1" }, { id: "1.1" }])))).toEqual({ ok: false, reason: "invalid_tasks" });
    expect(buildTaskQualityInput(bundle("## Tasks"))).toEqual({ ok: false, reason: "no_tasks" });
    expect(buildTaskQualityInput(bundle("").slice(0, 3))).toEqual({ ok: false, reason: "invalid_tasks" });
  });

  test("assesses forty tasks but not more", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `1.${index + 1}` }));
    const atCap = buildTaskQualityInput(bundle(tasksMd(many(TASK_QUALITY_MAX_TASKS))));
    expect(atCap.ok && atCap.input.tasks.length).toBe(40);
    expect(buildTaskQualityInput(bundle(tasksMd(many(TASK_QUALITY_MAX_TASKS + 1))))).toEqual({
      ok: false,
      reason: "too_many_tasks",
    });
  });

  test("keeps the change summary within 2,000 bytes on a character boundary", () => {
    const result = buildTaskQualityInput(bundle(tasksMd(twoTasks), { proposal: "é".repeat(3_000) }));
    if (!result.ok) throw new Error(result.reason);
    expect(Buffer.byteLength(result.input.summary, "utf8")).toBeLessThanOrEqual(TASK_QUALITY_SUMMARY_BYTES);
    expect(result.input.summary).toBe("é".repeat(1_000));
  });

  test("excerpts long requirement text while keeping every name", () => {
    const long = "The system SHALL keep going. ".repeat(500);
    const spec = [
      "### Requirement: Alpha",
      long,
      "#### Scenario: Alpha one",
      long,
      "### Requirement: Beta",
      "Short.",
      "#### Scenario: Beta one",
      "Also short.",
    ].join("\n");
    const result = buildTaskQualityInput(bundle(tasksMd(twoTasks), { spec }));
    if (!result.ok) throw new Error(result.reason);
    const [alpha, beta] = result.input.requirements;
    expect([alpha!.name, alpha!.scenarios[0]!.name, beta!.name, beta!.scenarios[0]!.name])
      .toEqual(["Alpha", "Alpha one", "Beta", "Beta one"]);
    expect(alpha!.text.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(alpha!.text, "utf8")).toBeLessThan(long.length);
    expect(beta!.text).toBe("Short.");
    expect(beta!.scenarios[0]!.text).toBe("Also short.");
  });

  test("drops text but keeps names when the tasks alone fill the state target", () => {
    const heavy = tasksMd(Array.from({ length: 40 }, (_, index) => ({
      id: `1.${index + 1}`,
      description: "x".repeat(2_500),
    })));
    const result = buildTaskQualityInput(bundle(heavy));
    if (!result.ok) throw new Error(result.reason);
    expect(result.input.requirements.map((requirement) => requirement.name)).toEqual(["Requirement one", "Requirement two"]);
    expect(result.input.requirements.every((requirement) => requirement.text === "")).toBe(true);
    expect(JSON.stringify(taskQualityState(result.input)).length).toBeGreaterThan(0);
  });
});

describe("taskDefinitionDigest", () => {
  const digestOf = (tasks: readonly TaskSpec[]) => {
    const result = buildTaskQualityInput(bundle(tasksMd(tasks)));
    if (!result.ok) throw new Error(result.reason);
    return result.digest;
  };

  test("is unchanged by ticking a checkbox", () => {
    expect(digestOf([{ id: "1.1", checked: true }, { id: "1.2" }])).toBe(digestOf([{ id: "1.1" }, { id: "1.2" }]));
  });

  test("changes when a scope, a verification command, a description, or a dependency changes", () => {
    const base = digestOf(twoTasks);
    expect(digestOf([{ id: "1.1", writes: ["src/b.ts"] }, twoTasks[1]!])).not.toBe(base);
    expect(digestOf([{ id: "1.1", verify: ["bun test tests/a.test.ts"] }, twoTasks[1]!])).not.toBe(base);
    expect(digestOf([{ id: "1.1", description: "Something else" }, twoTasks[1]!])).not.toBe(base);
    expect(digestOf([twoTasks[0]!, { id: "1.2" }])).not.toBe(base);
  });

  test("does not depend on the order tasks are listed in", () => {
    const [first, second] = twoTasks;
    expect(digestOf([{ ...second!, dependsOn: [] }, first!])).toBe(digestOf([first!, { ...second!, dependsOn: [] }]));
  });

  test("hashes the same definitions to the same digest", () => {
    const definition = { id: "1.1", description: "d", dependsOn: [], reads: [], writes: ["a"], verify: ["v"] };
    expect(taskDefinitionDigest([definition])).toBe(taskDefinitionDigest([{ ...definition }]));
    expect(taskDefinitionDigest([definition])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
