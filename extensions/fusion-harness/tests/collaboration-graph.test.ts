import { describe, expect, test } from "bun:test";
import { validateCollaborationPlan } from "../modules/collaboration-graph.ts";

const slots = ["architect", "main", "reviewer"];

describe("collaboration graph", () => {
  test("builds dependency waves", () => {
    const plan = validateCollaborationPlan({ tasks: [
      { id: "1.a", assignee: "architect", description: "design", depends_on: [], mode: "read", reads: ["src/**"], writes: [] },
      { id: "1.b", assignee: "main", description: "implement core", depends_on: [], outputs: ["core.ts"], mode: "write", reads: ["src/**"], writes: ["src/core.ts"] },
      { id: "2.a", assignee: "reviewer", description: "integrate", depends_on: ["1.a", "1.b"], mode: "write", reads: ["src/**"], writes: ["src/integration.ts"] },
    ]}, slots);
    expect(plan.waves.map((wave) => wave.map((task) => task.id))).toEqual([["1.a", "1.b"], ["2.a"]]);
  });

  test("defaults mode to write when write scopes are declared", () => {
    const plan = validateCollaborationPlan({ tasks: [{ id: "1.a", assignee: "main", description: "ship", depends_on: [], reads: ["src/**"], writes: ["src/**"] }] }, slots);
    expect(plan.tasks[0].mode).toBe("write");
  });

  test("rejects unknown assignees", () => {
    expect(() => validateCollaborationPlan({ tasks: [{ id: "1.a", assignee: "ghost", description: "x", depends_on: [], reads: ["src/**"], writes: ["src/**"] }] }, slots)).toThrow("unknown");
  });

  test("rejects mixed-type dependency and output entries instead of dropping them", () => {
    expect(() => validateCollaborationPlan({ tasks: [
      { id: "1.a", assignee: "main", description: "a", depends_on: [123], outputs: ["ok", false], reads: ["src/**"], writes: ["src/**"] },
    ]}, slots)).toThrow("entries must all be strings");
  });

  test("rejects cycles", () => {
    expect(() => validateCollaborationPlan({ tasks: [
      { id: "1.a", assignee: "main", description: "a", depends_on: ["1.b"], reads: ["src/**"], writes: ["src/a.ts"] },
      { id: "1.b", assignee: "reviewer", description: "b", depends_on: ["1.a"], reads: ["src/**"], writes: ["src/b.ts"] },
    ]}, slots)).toThrow("cycle");
  });

  test("allows two same-slot tasks in one dependency level (scheduler serializes per slot)", () => {
    const plan = validateCollaborationPlan({ tasks: [
      { id: "1.a", assignee: "main", description: "a", depends_on: [], reads: ["src/**"], writes: ["src/a.ts"] },
      { id: "1.b", assignee: "main", description: "b", depends_on: [], reads: ["src/**"], writes: ["src/b.ts"] },
    ]}, slots);
    expect(plan.waves.map((wave) => wave.map((task) => task.id))).toEqual([["1.a", "1.b"]]);
  });

  test("rejects missing, escaping, duplicate, and contradictory scopes", () => {
    expect(() => validateCollaborationPlan({ tasks: [
      { id: "1.a", assignee: "main", description: "missing", depends_on: [], mode: "write" },
    ]}, slots)).toThrow("reads must be an array");
    expect(() => validateCollaborationPlan({ tasks: [
      { id: "1.a", assignee: "main", description: "escape", depends_on: [], mode: "write", reads: ["../secret"], writes: ["src/**"] },
    ]}, slots)).toThrow("repository-relative");
    expect(() => validateCollaborationPlan({ tasks: [
      { id: "1.a", assignee: "main", description: "duplicate", depends_on: [], mode: "write", reads: ["src/./**", "src/**"], writes: ["src/**"] },
    ]}, slots)).toThrow("duplicate normalized scopes");
    expect(() => validateCollaborationPlan({ tasks: [
      { id: "1.a", assignee: "main", description: "contradiction", depends_on: [], mode: "read", reads: ["src/**"], writes: ["src/file.ts"] },
    ]}, slots)).toThrow("must be empty for read mode");
    expect(() => validateCollaborationPlan({ tasks: [
      { id: "1.a", assignee: "main", description: "broad", depends_on: [], mode: "write", reads: ["**"], writes: ["**"] },
    ]}, slots)).toThrow("must not grant repository-wide scope");
  });
});
