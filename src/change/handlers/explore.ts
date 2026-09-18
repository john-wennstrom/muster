import { defineChangeHandler } from "../handler.ts";
import { runProductionExploration } from "../phases/exploration.ts";

export const createExploreHandler = defineChangeHandler("explore", async (request) => {
  if (!request.prompt) {
    return { status: "blocked" as const, summary: "Usage: /change explore <prompt>" };
  }
  return (request.options.runners?.explore ?? runProductionExploration)({
    cwd: request.cwd,
    prompt: request.prompt,
    onAgentStart: request.onAgentStart,
    signal: request.signal,
    argv: request.options.argv,
  });
});
