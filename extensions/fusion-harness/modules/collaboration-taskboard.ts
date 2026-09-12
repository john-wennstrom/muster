import type { CollaborationTask, ValidatedCollaborationPlan } from "./collaboration-graph.ts";

export type CollaborationTaskState = "blocked" | "queued" | "reading" | "writing" | "done" | "failed";

export interface TaskboardRenderOptions {
	subtitle: string;
	describeTask?: (task: CollaborationTask) => string;
	descriptionMaxChars?: number;
}

const TASK_GLYPH: Record<CollaborationTaskState, string> = {
	blocked: "○",
	queued: "◌",
	reading: "◐",
	writing: "●",
	done: "✓",
	failed: "✗",
};

function squash(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

export function renderTaskboard(
	plan: ValidatedCollaborationPlan,
	taskState: ReadonlyMap<string, CollaborationTaskState>,
	options: TaskboardRenderOptions,
): string[] {
	const describeTask = options.describeTask ?? ((task: CollaborationTask) => task.description);
	const descriptionMaxChars = options.descriptionMaxChars ?? 60;
	const doneCount = [...taskState.values()].filter((state) => state === "done").length;
	return [
		`⇄ TASKS · ${doneCount}/${plan.tasks.length} done · ${options.subtitle}`,
		...plan.tasks.map((task) => {
			const state = taskState.get(task.id) ?? "blocked";
			const summary = clip(squash(describeTask(task)), descriptionMaxChars);
			return `  ${TASK_GLYPH[state]} ${task.id} · ${task.assignee} · ${task.mode} · ${state} · ${summary}`;
		}),
	];
}