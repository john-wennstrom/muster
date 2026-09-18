import { defineChangeHandler } from "../handler.ts";
import { runProductionReview } from "../phases/review.ts";

export const createReviewHandler = defineChangeHandler("review", async (request) =>
  (request.options.runners?.review ?? runProductionReview)({
    onAgentStart: request.onAgentStart,
    cwd: request.cwd,
    changeName: request.changeName,
    prompt: request.prompt || undefined,
    signal: request.signal,
    argv: request.options.argv,
    runId: request.runId,
  }));
