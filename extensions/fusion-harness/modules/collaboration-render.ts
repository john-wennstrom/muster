import type { CollaborationTask, ValidatedCollaborationPlan } from "./collaboration-graph.ts";

export interface DelegationPlanRenderOptions {
	heading?: string;
	describeTask?: (task: CollaborationTask) => string;
}

export function renderDelegationPlan(plan: ValidatedCollaborationPlan, options: DelegationPlanRenderOptions = {}): string {
	const describeTask = options.describeTask ?? ((task: CollaborationTask) => task.description);
	const lines: string[] = [];
	if (options.heading) {
		lines.push(options.heading, "");
	}
	lines.push(
		`### Delegation plan — ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"} · ${plan.waves.length} dependency level${plan.waves.length === 1 ? "" : "s"}`,
		"",
		"| task | owner | mode | depends on |",
		"|---|---|---|---|",
		...plan.tasks.map((task) => `| ${task.id} | ${task.assignee} | ${task.mode} | ${task.depends_on.join(", ") || "—"} |`),
		"",
		`Parallelism by level: ${plan.waves.map((wave, index) => `${index + 1}) ${wave.map((task) => task.id).join(" ∥ ")}`).join("  →  ")}`,
		"",
		...plan.tasks.map((task) => `- **${task.id}** (${task.assignee}, ${task.mode}) — ${describeTask(task)}`),
	);
	return lines.join("\n");
}