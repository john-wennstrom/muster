import { runProductionImplementation } from "../phases/implementation.ts";
import { defineChangeHandler } from "../handler.ts";

/** Builds the `/change implement` handler bound to the given cwd/options closure. */
export const createImplementHandler = defineChangeHandler("implement", async (request) => {
  const snapshot = await request.snapshot();
  return (request.options.runners?.implementation ?? runProductionImplementation)({
    onAgentStart: request.onAgentStart,
    cwd: request.cwd,
    changeName: request.changeName,
    reviewFreshness: snapshot?.freshness.review ?? "missing",
    signal: request.signal,
    argv: request.options.argv,
  });
});
