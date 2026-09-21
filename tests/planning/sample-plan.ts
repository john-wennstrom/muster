import type { ProposalPlan } from "../../src/planning/plan-schema.ts";

/** A small, valid plan the planning tests start from and then break one field at a time. */
export function samplePlan(overrides: Partial<ProposalPlan> = {}): ProposalPlan {
  return {
    disposition: "plan",
    summary: "Add a search box to the toolbar",
    why: "Users cannot find items without scrolling.",
    changes: ["Add a search box to the toolbar", "**BREAKING** none"],
    capabilities: { new: ["toolbar-search"], modified: [] },
    impact: ["`src/toolbar.ts` gains a filter"],
    requirements: [{
      capability: "toolbar-search",
      name: "The toolbar filters items",
      text: "The toolbar SHALL filter the visible items by the text typed into the search box.",
      scenarios: [
        { name: "Typing filters the list", when: "the user types `bo` into the search box", then: "only items containing `bo` are shown" },
        { name: "Clearing the box restores the list", when: "the user clears the search box", then: "every item is shown again" },
      ],
    }],
    design: {
      context: "The toolbar renders from `items`.",
      goals: ["Filter without a new dependency"],
      nonGoals: ["Fuzzy matching"],
      decisions: [{ title: "Filter in the view", body: "The view filters `items`, so the data layer is unchanged." }],
      risks: ["A very large list may need debouncing."],
    },
    tasks: [
      {
        id: "1.1",
        group: "Toolbar",
        description: "Add the filter to the toolbar view",
        dependsOn: [],
        reads: ["src/**"],
        writes: ["src/toolbar.ts", "tests/toolbar.test.ts"],
        requirements: [{ capability: "toolbar-search", name: "The toolbar filters items" }],
        scenarios: ["Typing filters the list", "Clearing the box restores the list"],
        verify: ["bun test tests/toolbar.test.ts"],
      },
      {
        id: "1.2",
        group: "Toolbar",
        description: "Document the search box",
        dependsOn: ["1.1"],
        reads: ["docs/**"],
        writes: ["docs/toolbar.md"],
        requirements: [{ capability: "toolbar-search", name: "The toolbar filters items" }],
        scenarios: ["Typing filters the list"],
        verify: ["bun run docs:check"],
      },
    ],
    ...overrides,
  };
}

/** The smallest plan: one requirement, one scenario, one task, and no design. */
export function sampleSmallPlan(): ProposalPlan {
  return {
    disposition: "plan",
    summary: "Rename the debug flag",
    why: "The flag name is misleading.",
    changes: ["Rename `--verbose` to `--debug`"],
    capabilities: { new: [], modified: ["cli"] },
    impact: [],
    requirements: [{
      capability: "cli",
      name: "The debug flag is accepted",
      kind: "MODIFIED",
      text: "The command line SHALL accept `--debug` to enable debug output.",
      scenarios: [{ name: "Debug flag enables debug output", when: "the command runs with `--debug`", then: "debug output is printed" }],
    }],
    tasks: [{
      id: "1.1",
      group: "CLI",
      description: "Rename the flag in the parser and its help text",
      dependsOn: [],
      reads: ["src/**"],
      writes: ["src/cli.ts", "tests/cli.test.ts"],
      requirements: [{ capability: "cli", name: "The debug flag is accepted" }],
      scenarios: ["Debug flag enables debug output"],
      verify: ["bun test tests/cli.test.ts"],
    }],
  };
}
