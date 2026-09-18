import { runProductionPlanning } from "../phases/planning.ts";
import { defineChangeHandler } from "../handler.ts";

/** Builds the `/change refine` handler bound to the given cwd/options closure. */
export const createRefineHandler = defineChangeHandler("refine", async (request) =>
  (request.options.runners?.planning ?? runProductionPlanning)({
    cwd: request.cwd,
    changeName: request.changeName,
    phase: "refine",
    onAgentStart: request.onAgentStart,
    runId: request.runId,
    prompt: request.prompt,
    signal: request.signal,
    argv: request.options.argv,
  }));
