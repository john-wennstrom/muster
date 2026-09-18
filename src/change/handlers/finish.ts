import { defineChangeHandler } from "../handler.ts";
import { runProductionFinish } from "../phases/finish.ts";

export const createFinishHandler = defineChangeHandler("finish", async (request) =>
  (request.options.runners?.finish ?? runProductionFinish)({
    cwd: request.cwd,
    changeName: request.changeName,
    onAgentStart: request.onAgentStart,
    signal: request.signal,
    argv: request.options.argv,
  }));
