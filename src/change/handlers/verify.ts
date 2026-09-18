import { defineChangeHandler } from "../handler.ts";
import { runProductionVerification } from "../phases/verification.ts";

export const createVerifyHandler = defineChangeHandler("verify", async (request) =>
  (request.options.runners?.verification ?? runProductionVerification)({
    cwd: request.cwd,
    changeName: request.changeName,
    onAgentStart: request.onAgentStart,
    signal: request.signal,
    argv: request.options.argv,
  }));
