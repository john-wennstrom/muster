import { runProductionImplementation } from "../phases/implementation.ts";
import { defineChangeHandler } from "../handler.ts";

/** Builds the `/change resume` handler bound to the given cwd/options closure. */
export const createResumeHandler = defineChangeHandler("resume", async (request) => {
  const snapshot = await request.snapshot();
  return (request.options.runners?.implementation ?? runProductionImplementation)({
    cwd: request.cwd,
    changeName: request.changeName,
    reviewFreshness: snapshot?.freshness.review ?? "missing",
    checkpointId: request.args[0]!,
    onAgentStart: request.onAgentStart,
    confirmedBy: request.actor,
    signal: request.signal,
    argv: request.options.argv,
  });
});
