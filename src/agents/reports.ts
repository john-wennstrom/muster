import { z } from "zod";

const boundedLine = z.string().min(1).max(2_000).refine((value) => !value.includes("\0"));

export const dependencyReportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: boundedLine,
  taskId: boundedLine,
  outcome: z.enum(["completed", "blocked", "awaiting_user", "design_conflict"]),
  summary: z.string().min(1).max(8_000),
  changedInterfaces: z.array(boundedLine).max(100),
  evidence: z.array(boundedLine).max(100),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export type DependencyReport = z.infer<typeof dependencyReportSchema>;

export const decisionCapsuleSchema = z.object({
  schemaVersion: z.literal(1),
  runId: boundedLine,
  decisionId: boundedLine,
  summary: z.string().min(1).max(4_000),
  rationale: z.string().min(1).max(4_000),
  affectedTasks: z.array(boundedLine).max(100),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export type DecisionCapsule = z.infer<typeof decisionCapsuleSchema>;

export function createDependencyReport(report: DependencyReport): DependencyReport {
  return dependencyReportSchema.parse(report);
}

export function createDecisionCapsule(capsule: DecisionCapsule): DecisionCapsule {
  return decisionCapsuleSchema.parse(capsule);
}

export function renderDependencyReports(reports: readonly DependencyReport[]): string {
  if (reports.length === 0) return "No completed dependencies.";
  return reports.map((report) => [
    `## Dependency ${report.taskId} (${report.outcome})`,
    report.summary,
    "Changed interfaces:",
    ...(report.changedInterfaces.length ? report.changedInterfaces.map((item) => `- ${item}`) : ["- None"]),
    "Evidence:",
    ...(report.evidence.length ? report.evidence.map((item) => `- ${item}`) : ["- None"]),
  ].join("\n")).join("\n\n");
}