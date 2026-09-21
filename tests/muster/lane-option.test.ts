import { describe, expect, test } from "bun:test";
import { createProposeHandler } from "../../src/change/handlers/propose.ts";
import { createRefineHandler } from "../../src/change/handlers/refine.ts";
import { changeCommands } from "../../src/change/commands.ts";
import type { ChangeCommandContext } from "../../src/change/change-command.ts";
import type { CommandOutcome } from "../../src/change/command.ts";
import { extractLaneArgument, parseChangeCommand } from "../../src/change/parse.ts";
import type { ProductionPlanningOptions } from "../../src/change/phases/planning.ts";

const context: ChangeCommandContext = { ui: { notify() {} } };

function harness() {
  const calls: ProductionPlanningOptions[] = [];
  const options = {
    runners: {
      async planning(planning: ProductionPlanningOptions): Promise<CommandOutcome> {
        calls.push(planning);
        return { status: "success", action: "propose", summary: "planned" };
      },
    },
  };
  return { calls, propose: createProposeHandler("/repo", options), refine: createRefineHandler("/repo", options) };
}

const run = (handler: ReturnType<typeof harness>["propose"], raw: string) => handler(parseChangeCommand(raw)!, context);

describe("the lane argument", () => {
  test("lane=small right after the change name is passed on and removed from the goal", async () => {
    const { calls, propose } = harness();
    await run(propose, "propose add-search lane=small Add a search box");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ changeName: "add-search", lane: "small", prompt: "Add a search box" });
  });

  test("each lane name is accepted, for propose and refine", async () => {
    for (const lane of ["small", "medium", "large"] as const) {
      const { calls, propose, refine } = harness();
      await run(propose, `propose add-search lane=${lane} Add it`);
      await run(refine, `refine add-search lane=${lane} tighten the scenarios`);
      expect(calls.map((call) => [call.phase, call.lane, call.prompt])).toEqual([
        ["propose", lane, "Add it"],
        ["refine", lane, "tighten the scenarios"],
      ]);
    }
  });

  test("without the argument there is no lane and the goal is untouched", async () => {
    const { calls, propose } = harness();
    await run(propose, "propose add-search Add a search box");
    expect(calls[0]!.lane).toBeUndefined();
    expect(calls[0]!.prompt).toBe("Add a search box");
  });

  test("a goal that starts with a lane name is not a lane", async () => {
    const { calls, propose, refine } = harness();
    await run(propose, "propose add-search small changes to the search box");
    await run(propose, "propose add-search large lane=medium mentioned later in the goal");
    await run(refine, "refine add-search medium effort please");
    expect(calls.map((call) => [call.lane, call.prompt])).toEqual([
      [undefined, "small changes to the search box"],
      [undefined, "large lane=medium mentioned later in the goal"],
      [undefined, "medium effort please"],
    ]);
  });

  test("an invalid lane blocks with the usage line and starts nothing", async () => {
    const { calls, propose, refine } = harness();
    for (const raw of ["propose add-search lane=huge Add a search box", "propose add-search lane= Add a search box"]) {
      const outcome = await run(propose, raw);
      expect(outcome).toMatchObject({ status: "blocked", action: "propose" });
      expect((outcome as { summary: string }).summary).toContain(changeCommands.propose.usage);
    }
    const refined = await run(refine, "refine add-search lane=tiny tighten it");
    expect(refined).toMatchObject({ status: "blocked", action: "refine" });
    expect((refined as { summary: string }).summary).toContain(changeCommands.refine.usage);
    expect(calls).toEqual([]);
  });

  test("the lane is a plain argument, not a launch flag", () => {
    expect(extractLaneArgument(["lane=large", "Add", "it"])).toEqual({ kind: "lane", lane: "large", rest: ["Add", "it"] });
    expect(extractLaneArgument(["--lane=large"])).toEqual({ kind: "none", rest: ["--lane=large"] });
    expect(extractLaneArgument([])).toEqual({ kind: "none", rest: [] });
  });

  test("the usage lines document the argument", () => {
    expect(changeCommands.propose.usage).toBe("/change propose <change> [lane=small|medium|large] <goal>");
    expect(changeCommands.refine.usage).toBe("/change refine <change> [lane=small|medium|large] [guidance]");
  });
});
