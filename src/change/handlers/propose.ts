import { runProductionPlanning } from "../phases/planning.ts";
import { defineChangeHandler } from "../handler.ts";

/** Builds the `/change propose` handler bound to the given cwd/options closure. */
export const createProposeHandler = defineChangeHandler("propose", async (request) => {
  if (!request.changeName) {
    return {
      status: "blocked" as const,
      summary: "Usage: /change propose <change> [lane=small|medium|large] <goal>",
      next: "/change propose <change> [lane=small|medium|large] <goal>",
    };
  }
  return (request.options.runners?.planning ?? runProductionPlanning)({
    cwd: request.cwd,
    changeName: request.changeName,
    phase: "propose",
    onAgentStart: request.onAgentStart,
    runId: request.runId,
    prompt: request.prompt,
    lane: request.lane,
    signal: request.signal,
    argv: request.options.argv,
  });
});
