import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { BrokerChildRole } from "./broker-server.ts";
import {
  dependencyReportSchema,
  renderDependencyReports,
  type DependencyReport,
} from "./reports.ts";

export interface FreshRoleTaskOptions<TResult> {
  runId: string;
  taskId: string;
  role: BrokerChildRole;
  sessionsRoot: string;
  prompt: string;
  dependencyReports?: readonly DependencyReport[];
  execute: (request: FreshRoleTaskRequest) => Promise<TResult>;
}

export interface FreshRoleTaskRequest {
  runId: string;
  taskId: string;
  role: BrokerChildRole;
  sessionId: string;
  sessionDir: string;
  prompt: string;
  dependencyReports: readonly DependencyReport[];
}

function safeSegment(value: string, field: string): string {
  const segment = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment || segment === "." || segment === "..") throw new Error(`${field} cannot form a session path`);
  return segment;
}

export function createFreshRoleSession(
  sessionsRoot: string,
  runId: string,
  taskId: string,
  role: BrokerChildRole,
): { sessionId: string; sessionDir: string } {
  const sessionId = randomUUID();
  return {
    sessionId,
    sessionDir: resolve(
      sessionsRoot,
      safeSegment(runId, "runId"),
      safeSegment(taskId, "taskId"),
      role,
      sessionId,
    ),
  };
}

export async function runFreshRoleTask<TResult>(
  options: FreshRoleTaskOptions<TResult>,
): Promise<TResult> {
  const dependencyReports = (options.dependencyReports ?? []).map((report) =>
    dependencyReportSchema.parse(report)
  );
  const session = createFreshRoleSession(
    options.sessionsRoot,
    options.runId,
    options.taskId,
    options.role,
  );
  return options.execute({
    runId: options.runId,
    taskId: options.taskId,
    role: options.role,
    ...session,
    dependencyReports,
    prompt: `${options.prompt}\n\nDEPENDENCY REPORTS\n${renderDependencyReports(dependencyReports)}`,
  });
}