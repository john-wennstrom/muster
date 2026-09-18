import { changeStateQuery } from "../command.ts";
import { defineChangeHandler } from "../handler.ts";
import { runProductionStatus } from "../phases/status.ts";

export const createStatusHandler = defineChangeHandler("status", async (request) =>
  runProductionStatus({
    ...changeStateQuery(request.options, request.cwd, request.changeName),
    snapshot: await request.snapshot(),
    loadUsage: request.options.ports?.loadUsage,
  }));
