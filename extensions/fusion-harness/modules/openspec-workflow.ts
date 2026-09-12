import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runChild, runProc } from "./child-runner.ts";
import { validateCollaborationPlan, type CollaborationTask, type ValidatedCollaborationPlan } from "./collaboration-graph.ts";
import { renderDelegationPlan } from "./collaboration-render.ts";
import { renderTaskboard, type CollaborationTaskState } from "./collaboration-taskboard.ts";
import { slotId, type ModelSlot } from "./model-stack.ts";
import { collabExecutePrompt, collabProposePrompt, contractSystemPrompt, openSpecArtifactPrompt, openSpecCollaboratePrompt, openSpecDebatePrompt, openSpecDesignPrompt, openSpecTasksPrompt, parseStrictJsonObject } from "./prompt-library.ts";
import { CUSTOM_TYPE, newRun, runError, runOk, toStat, type AgentRun, type HarnessDeps } from "./runtime.ts";
import { acquireWriterLease, type WriterLease } from "./writer-lease.ts";

export interface OpenSpecArtifact { name: string; path: string; content?: string; contextFiles: string[]; }
export interface OpenSpecTask { id: string; phase: number; phaseTitle: string; description: string; checked: boolean; requirements: string[]; scenarios: string[]; verifyCommands: string[]; }
export interface OpenSpecPhase { number: number; title: string; tasks: OpenSpecTask[]; }
export interface DebateResult { runs: AgentRun[]; text: string; }
export interface ArtifactResult { run: AgentRun; content: string; }

/** OpenSpec is an optional integration; absence must not prevent the core harness from loading. */
export function isOpenSpecAvailable(): boolean {
	try {
		const result = spawnSync("openspec", ["--version"], { stdio: "ignore", timeout: 2_000 });
		return !result.error && result.status !== null;
	} catch {
		return false;
	}
}

const parseJson = (value: string, label: string): any => {
	try { return JSON.parse(value); } catch (error) { throw new Error(`openspec ${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
};

export class OpenSpecClient {
	constructor(private readonly cwd: string, private readonly signal?: AbortSignal) {}
	private async command(args: string[], label: string): Promise<{ code: number; output: string }> {
		const result = await runProc("openspec", args, this.cwd, 120_000, this.signal);
		if (result.code !== 0) throw new Error(`openspec ${label} failed (exit ${result.code}):\n${result.output.trim()}`);
		return result;
	}
	private static verifyCommandMissing(output: string): boolean {
		return /unknown command ['"]verify['"]|unrecognized (?:sub)?command ['"]verify['"]|no such command ['"]verify['"]/i.test(output);
	}
	async status(change: string): Promise<any> { return parseJson((await this.command(["status", "--change", change, "--json"], "status")).output, "status"); }
	async instructions(artifact: string, change: string): Promise<any> { return parseJson((await this.command(["instructions", artifact, "--change", change, "--json"], "instructions")).output, "instructions"); }
	async validate(change: string): Promise<void> { await this.command(["validate", change, "--strict"], "strict validation"); }
	async verify(change: string): Promise<void> { await this.command(["verify", change], "verification"); }
	async verifyIfSupported(change: string): Promise<{ supported: boolean }> {
		const result = await runProc("openspec", ["verify", change], this.cwd, 120_000, this.signal);
		if (result.code === 0) return { supported: true };
		if (OpenSpecClient.verifyCommandMissing(result.output)) return { supported: false };
		throw new Error(`openspec verification failed (exit ${result.code}):\n${result.output.trim()}`);
	}
	async archive(change: string): Promise<void> { await this.command(["archive", change, "-y"], "archive"); }
}

function walk(value: unknown, visit: (object: Record<string, unknown>) => void): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) { for (const item of value) walk(item, visit); return; }
	const object = value as Record<string, unknown>; visit(object);
	for (const child of Object.values(object)) walk(child, visit);
}

export function resolveArtifact(raw: any, name: string, cwd: string, change: string): OpenSpecArtifact {
	const artifactPath = path.resolve(cwd, "openspec", "changes", change, `${name}.md`);
	const contextFiles = new Set<string>();
	walk(raw, (object) => {
		for (const key of ["path", "outputPath", "file", "filePath"]) {
			if (typeof object[key] !== "string" || !/\.md$|\.yaml$|\.yml$|\.json$/.test(object[key] as string)) continue;
			contextFiles.add(path.resolve(cwd, object[key] as string));
		}
	});
	contextFiles.add(artifactPath); let content: string | undefined;
	try { content = fs.readFileSync(artifactPath, "utf8"); } catch { /* artifact may not exist yet */ }
	return { name, path: artifactPath, content, contextFiles: [...contextFiles] };
}

export function parseTaskPlan(content: string): OpenSpecPhase[] {
	const phases: OpenSpecPhase[] = []; let phase: OpenSpecPhase | undefined;
	for (const line of content.split(/\r?\n/)) {
		const heading = line.match(/^##\s+(?:Phase\s+)?(\d+)\s*(?:[-—:]\s*)?(.*)$/i);
		if (heading) { phase = { number: Number(heading[1]), title: heading[2].trim() || `Phase ${heading[1]}`, tasks: [] }; phases.push(phase); continue; }
		const item = line.match(/^\s*-\s*\[([ xX])\]\s+([\d.]+)\s+(.+)$/);
		if (item && phase) phase.tasks.push({ id: item[2], phase: phase.number, phaseTitle: phase.title, description: item[3].trim(), checked: item[1].toLowerCase() === "x", requirements: [], scenarios: [], verifyCommands: [] });
	}
	let current: OpenSpecTask | undefined;
	for (const line of content.split(/\r?\n/)) {
		const item = line.match(/^\s*-\s*\[([ xX])\]\s+([\d.]+)\s+(.+)$/);
		if (item) { current = phases.flatMap((candidate) => candidate.tasks).find((candidate) => candidate.id === item[2]); continue; }
		if (!current) continue;
		const requirement = line.match(/Requirement:\s*(.+)/i); const scenario = line.match(/Scenario(?:\s*:)?\s*["“]?(.+?)["”]?\s*$/i); const command = line.match(/Verify command:\s*`([^`]+)`/i);
		if (requirement) current.requirements.push(requirement[1].trim()); if (scenario) current.scenarios.push(scenario[1].trim()); if (command) current.verifyCommands.push(command[1].trim());
	}
	return phases;
}

async function readContext(files: string[]): Promise<string> {
	const parts: string[] = [];
	for (const file of files) try { parts.push(`\n--- ${file} ---\n${await fs.promises.readFile(file, "utf8")}`); } catch { /* optional dependency artifact */ }
	return parts.join("\n");
}

async function atomicWrite(file: string, content: string): Promise<void> {
	const temporary = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(temporary, `${content.trim()}\n`, "utf8"); await fs.promises.rename(temporary, file);
}

async function runReadOnlyAgent(h: HarnessDeps, ctx: any, slot: ModelSlot, prompt: string): Promise<AgentRun> {
	const run = newRun("ARCHITECT", slot.model, slot);
	await runChild({ run, prompt, systemPrompt: slot.systemPrompt, appendSystemPrompts: slot.appendSystemPrompts, access: "read", childRuntime: h.resolveChildRuntime(slot, "read"), thinking: slot.thinking, ...h.slotInitialSpawn(slot, ctx, await h.mkArtifacts()), cwd: ctx.cwd, timeoutMs: h.childTimeoutMs() });
	return run;
}

export async function runDebate(h: HarnessDeps, ctx: any, change: string, context: string): Promise<DebateResult> {
	const stack = h.modelStack();
	const runs = stack.slots.map((slot) => newRun("ARCHITECT", slot.model, slot));
	const startedAt = Date.now();
	const stopWidget = h.startGridWidget(ctx, "refine", runs, undefined, startedAt);
	try {
		await Promise.all(runs.map(async (run) => {
			const slot = run.slot!;
			await runChild({ run, prompt: openSpecDebatePrompt(change, context), systemPrompt: slot.systemPrompt, appendSystemPrompts: slot.appendSystemPrompts, access: "read", childRuntime: h.resolveChildRuntime(slot, "read"), thinking: slot.thinking, ...h.slotInitialSpawn(slot, ctx, await h.mkArtifacts()), cwd: ctx.cwd, timeoutMs: h.childTimeoutMs() });
		}));
		return { runs, text: runs.map((run) => `## ${run.model}\n${runOk(run) ? run.text : runError(run)}`).join("\n\n") };
	} finally {
		stopWidget();
		h.absorbRuns(runs);
	}
}

export async function runFusionArtifact(h: HarnessDeps, ctx: any, slot: ModelSlot, change: string, artifact: string, context: string, instruction: string): Promise<ArtifactResult> {
	const run = await runReadOnlyAgent(h, ctx, slot, artifactPrompt(change, artifact, context, instruction));
	return { run, content: runOk(run) ? run.text : "" };
}

export async function runOpenSpecCollaboratePhase(h: HarnessDeps, ctx: any, change: string, phase: OpenSpecPhase, context: string): Promise<void> {
	const stack = h.modelStack();
	const TASKBOARD_WIDGET = `${CUSTOM_TYPE}-taskboard`;
	const taskIds = phase.tasks.map((task, index) => `${phase.number}.${String.fromCharCode(97 + index)}`);
	const taskById = new Map(phase.tasks.map((task, index) => [taskIds[index], task]));
	const taskText = phase.tasks.map((task, index) => `- ${taskIds[index]} (OpenSpec task ${task.id}): ${task.description}`).join("\n");
	const proposalRuns = stack.slots.map((slot) => newRun(slot.architect ? "ARCHITECT" : "BUILDER", slot.model, slot));
	const proposalWidget = h.startGridWidget(ctx, "implement", proposalRuns, undefined, Date.now());
	try {
		await Promise.all(proposalRuns.map(async (run) => {
			const slot = run.slot!;
			await runChild({ run, prompt: collabProposePrompt(slot, stack, `Implement OpenSpec change ${change}, phase ${phase.number} — ${phase.title}. Propose concrete work for only these tasks:\n${taskText}\n\n${context}`), systemPrompt: slot.systemPrompt, appendSystemPrompts: slot.appendSystemPrompts, access: "read", childRuntime: h.resolveChildRuntime(slot, "read"), thinking: slot.thinking, ...h.slotInitialSpawn(slot, ctx, await h.mkArtifacts()), cwd: ctx.cwd, timeoutMs: h.childTimeoutMs() });
		}));
	} finally { proposalWidget(); h.absorbRuns(proposalRuns); }
	h.panel({ kind: "multi", command: "implement", title: "IMPLEMENT — COLLABORATION PROPOSALS", ok: proposalRuns.every(runOk), prompt: change, sources: proposalRuns.map(toStat), answers: proposalRuns.map((run) => ({ role: run.role, model: run.model, text: runOk(run) ? run.text : `FAILED: ${runError(run)}`, slotId: run.slot?.id, slotName: run.slot?.name, color: run.slot?.color, primary: run.slot?.primary })) }, proposalRuns.map((run) => `## ${run.slot?.name ?? run.model}\n${runOk(run) ? run.text : runError(run)}`).join("\n\n"));
	if (proposalRuns.filter(runOk).length < 2) throw new Error("phase collaboration needs at least two successful agent proposals");

	const planRun = newRun("ARCHITECT", stack.architect.model, stack.architect);
	const basePlanPrompt = openSpecCollaboratePrompt(change, phase.number, phase.title, taskText, stack.slots.map((slot) => slot.id).join(", "), taskIds[0], stack.slots[0].id, `${context}\n\nPROPOSALS:\n${proposalRuns.map((run) => `## ${run.slot?.name}\n${run.text}`).join("\n\n")}`);
	const architectSpawn = h.slotInitialSpawn(stack.architect, ctx, await h.mkArtifacts());
	let plan: ValidatedCollaborationPlan | undefined;
	let rawPlan: Record<string, unknown> | undefined;
	let planError = "";
	for (let attempt = 1; attempt <= 3; attempt++) {
		ctx.ui.setStatus("fusion-harness", `implement: architect building delegation plan${attempt > 1 ? ` (repair ${attempt - 1})` : ""}…`);
		const repairHint = planError
			? `\n\nPREVIOUS PLAN VALIDATION FAILED:\n${planError}\nReturn one corrected raw JSON object only. No markdown, no prose, no code fences.`
			: "";
		const prompt = `${basePlanPrompt}${repairHint}`;
		await runChild({
			run: planRun,
			prompt,
			systemPrompt: contractSystemPrompt(stack.architect.systemPrompt, "SYSTEM_PROMPT_COLLAB_COORDINATOR.md"),
			appendSystemPrompts: stack.architect.appendSystemPrompts,
			access: "read",
			childRuntime: h.resolveChildRuntime(stack.architect, "read"),
			thinking: stack.architect.thinking,
			...(attempt === 1 ? architectSpawn : h.slotNextSpawn(stack.architect, planRun, architectSpawn, ctx)),
			cwd: ctx.cwd,
			timeoutMs: h.childTimeoutMs(),
		});
		if (!runOk(planRun)) throw new Error(`phase delegation failed: ${runError(planRun)}`);
		try {
			const parsedPlan = parseStrictJsonObject(planRun.text, "phase delegation plan");
			if (Array.isArray((parsedPlan as Record<string, unknown>).tasks)) {
				for (const rawTask of (parsedPlan as { tasks: unknown[] }).tasks) {
					if (rawTask && typeof rawTask === "object" && typeof (rawTask as Record<string, unknown>).assignee === "string") {
						(rawTask as Record<string, string>).assignee = slotId((rawTask as Record<string, string>).assignee);
					}
				}
			}
			const candidatePlan = validateCollaborationPlan(parsedPlan, stack.slots.map((slot) => slot.id));
			if (candidatePlan.tasks.some((task) => !taskById.has(task.id))) throw new Error("phase delegation referenced a task outside the selected OpenSpec phase");
			if (candidatePlan.tasks.length !== taskIds.length || taskIds.some((id) => !candidatePlan.tasks.some((task) => task.id === id))) throw new Error("phase delegation must assign every selected OpenSpec task exactly once");
			plan = candidatePlan;
			rawPlan = parsedPlan;
			break;
		} catch (error) {
			planError = error instanceof Error ? error.message : String(error);
			plan = undefined;
			rawPlan = undefined;
		}
	}
	if (!plan || !rawPlan) throw new Error(`phase delegation failed after 3 attempts:\n${planError}`);
	const planBody = renderDelegationPlan(plan, {
		heading: "IMPLEMENT — DELEGATION PLAN",
		describeTask: (task) => {
			const original = taskById.get(task.id)!;
			return `OpenSpec ${original.id}: ${original.description}`;
		},
	});
	h.panel({ kind: "solo", command: "implement", ok: true, prompt: change, agent: toStat(planRun) }, planBody);

	const executionRuns = stack.slots.map((slot) => newRun(slot.architect ? "ARCHITECT" : "BUILDER", slot.model, slot));
	const executionWidget = h.startGridWidget(ctx, "implement", executionRuns, undefined, Date.now());
	const taskState = new Map<string, CollaborationTaskState>(plan.tasks.map((task) => [task.id, "blocked"]));
	const renderBoard = (): void => {
		try {
			ctx.ui.setWidget(TASKBOARD_WIDGET, renderTaskboard(plan, taskState, {
				subtitle: `phase ${phase.number}`,
				descriptionMaxChars: 56,
				describeTask: (task) => {
					const original = taskById.get(task.id)!;
					return `OpenSpec ${original.id}: ${original.description}`;
				},
			}), { placement: "belowEditor" });
		} catch {}
	};
	renderBoard();
	try {
		for (const wave of plan.waves) {
			for (const task of wave) if (taskState.get(task.id) === "blocked") taskState.set(task.id, "queued");
			renderBoard();
			for (const task of wave) {
				const slot = stack.slots.find((candidate) => candidate.id === task.assignee)!;
				const run = executionRuns.find((candidate) => candidate.slot?.id === slot.id)!;
				const original = taskById.get(task.id)!;
				const handoff = `OpenSpec task ${original.id}. Requirements: ${original.requirements.join(", ") || "see specs"}. Scenarios: ${original.scenarios.join(", ") || "see specs"}. Verify commands: ${original.verifyCommands.join(", ") || "none"}.`;
				taskState.set(task.id, task.mode === "read" ? "reading" : "writing");
				renderBoard();
				await runChild({ run, prompt: collabExecutePrompt(slot, `Implement OpenSpec change ${change}, phase ${phase.number} — ${phase.title}.`, task, handoff), systemPrompt: slot.systemPrompt, appendSystemPrompts: slot.appendSystemPrompts, access: task.mode === "read" ? "read" : "write", childRuntime: h.resolveChildRuntime(slot, task.mode === "read" ? "read" : "write"), thinking: slot.thinking, ...h.slotNextSpawn(slot, run, h.slotInitialSpawn(slot, ctx, await h.mkArtifacts()), ctx), cwd: ctx.cwd, timeoutMs: h.buildTimeoutMs() });
				if (!runOk(run)) {
					taskState.set(task.id, "failed");
					renderBoard();
					throw new Error(`task ${original.id} (${slot.id}) failed: ${runError(run)}`);
				}
				taskState.set(task.id, "done");
				renderBoard();
				h.panel({ kind: "solo", command: "implement", ok: true, prompt: change, agent: toStat(run) }, `IMPLEMENT — TASK ${original.id}\n\n${run.text}`);
			}
		}
	} finally {
		executionWidget();
		h.absorbRuns(executionRuns);
		try { ctx.ui.setWidget(TASKBOARD_WIDGET, undefined); } catch {}
	}
}

function artifactPrompt(change: string, artifact: string, context: string, instruction: string): string {
	return openSpecArtifactPrompt(change, artifact, instruction, context);
}

function parseChange(raw: string, command: string): { change: string; phase?: number } | undefined {
	const parts = raw.trim().split(/\s+/).filter(Boolean); if (!parts[0]) return undefined;
	const phase = parts[1] && parts[1].toLowerCase() !== "next" ? Number(parts[1]) : undefined;
	if (phase !== undefined && (!Number.isInteger(phase) || phase < 1)) throw new Error(`${command}: phase must be a positive integer or next`);
	return { change: parts[0], phase };
}

function reportWorkflowError(h: HarnessDeps, ctx: any, command: string, change: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	h.panel({ kind: "error", command, ok: false, prompt: change, error: message }, `${command.toUpperCase()}: BLOCKED\n\n${message}`);
	ctx.ui.notify(`${command}: ${message}`, "error");
}

function requireOpenSpec(h: HarnessDeps, ctx: any, command: string, change: string): boolean {
	if (isOpenSpecAvailable()) return true;
	reportWorkflowError(h, ctx, command, change, "OpenSpec CLI is unavailable in Pi's environment. Install `openspec` and restart Pi, or ensure its directory is on Pi's PATH.");
	return false;
}

export function registerOpenSpecCommands(pi: ExtensionAPI, h: HarnessDeps): void {
	const clientFor = (ctx: any) => new OpenSpecClient(ctx.cwd);
	pi.registerCommand("os-status", { description: "Show OpenSpec planning and implementation state", handler: async (raw: any, ctx: any) => {
		const change = (raw ?? "").trim().split(/\s+/)[0]; if (!change) return ctx.ui.notify("Usage: /os-status <change>", "warning");
		if (!requireOpenSpec(h, ctx, "os-status", change)) return;
		try { const client = clientFor(ctx); const status = await client.status(change); const tasks = resolveArtifact(await client.instructions("tasks", change), "tasks", ctx.cwd, change); const phases = parseTaskPlan(tasks.content ?? ""); const summary = phases.map((item) => `Phase ${item.number} — ${item.title}: ${item.tasks.filter((task) => task.checked).length}/${item.tasks.length} complete`).join("\n") || "No task phases found."; h.panel({ kind: "solo", command: "os-status", ok: true, prompt: change }, `Change: ${change}\n\n${JSON.stringify(status, null, 2)}\n\n${summary}`); } catch (error) { reportWorkflowError(h, ctx, "os-status", change, error); }
	}});

	pi.registerCommand("refine", { description: "Adversarially review and refine an OpenSpec change", handler: async (raw: any, ctx: any) => {
		const change = (raw ?? "").trim().split(/\s+/)[0]; if (!change) return ctx.ui.notify("Usage: /refine <change> [--allow-open]", "warning");
		if (!requireOpenSpec(h, ctx, "refine", change)) return;
		const allowOpen = (raw ?? "").includes("--allow-open"); let lease: WriterLease | undefined;
		try {
			ctx.ui.setStatus("fusion-harness", `refine: loading OpenSpec change ${change}…`);
			h.panel({ kind: "banner", command: "refine", ok: true, prompt: change }, `REFINE: STARTING\n\nLoading OpenSpec artifacts and preparing ${h.modelStack().slots.length} read-only debate agents.`);
			const client = clientFor(ctx); await client.status(change); const design = resolveArtifact(await client.instructions("design", change), "design", ctx.cwd, change); const tasks = resolveArtifact(await client.instructions("tasks", change), "tasks", ctx.cwd, change); const context = await readContext([...new Set([...design.contextFiles, ...tasks.contextFiles])]); const stack = h.modelStack();
			const debate = await runDebate(h, ctx, change, context); const architect = stack.architect;
			h.panel({ kind: "multi", command: "refine", title: "REFINE — ADVERSARIAL DEBATE RESULTS", ok: debate.runs.every(runOk), prompt: change, sources: debate.runs.map(toStat), answers: debate.runs.map((run) => ({ role: run.role, model: run.model, text: runOk(run) ? run.text : `FAILED: ${runError(run)}`, slotId: run.slot?.id, slotName: run.slot?.name, color: run.slot?.color, primary: run.slot?.primary })) }, debate.text);
			ctx.ui.setStatus("fusion-harness", "refine: synthesizing revised design…");
			const revisedDesign = await runReadOnlyAgent(h, ctx, architect, openSpecDesignPrompt(change, context, debate.text));
			if (!runOk(revisedDesign)) throw new Error(`design synthesis failed: ${runError(revisedDesign)}`);
			h.panel({ kind: "solo", command: "refine", ok: true, prompt: change, agent: { role: revisedDesign.role, model: revisedDesign.model, slotId: architect.id, slotName: architect.name, color: architect.color, primary: architect.primary, status: revisedDesign.status, ms: revisedDesign.ms, tokensIn: revisedDesign.tokensIn, tokensOut: revisedDesign.tokensOut, costUsd: revisedDesign.costUsd, toolCalls: revisedDesign.toolCalls, toolNames: revisedDesign.toolNames, toolEvents: revisedDesign.toolEvents, chars: revisedDesign.text.length } }, `REFINE: DESIGN SYNTHESIS\n\n${revisedDesign.text}`);
			const questionSection = revisedDesign.text.match(/^#{1,2}\s*Open Questions?\s*$([\s\S]*?)(?=^#{1,2}\s|$)/im)?.[1]?.trim() ?? "";
			if (questionSection && !allowOpen) { h.panel({ kind: "error", command: "refine", ok: false, prompt: change }, `REFINE: NEEDS REVIEW\n\n${questionSection}\n\nTasks generation skipped.`); return; }
			lease = acquireWriterLease(ctx.cwd, `/refine ${change}`); await atomicWrite(design.path, revisedDesign.text);
			ctx.ui.setStatus("fusion-harness", "refine: synthesizing implementation tasks…");
			const revisedTasks = await runReadOnlyAgent(h, ctx, architect, openSpecTasksPrompt(change, context, revisedDesign.text));
			if (!runOk(revisedTasks)) throw new Error(`task synthesis failed: ${runError(revisedTasks)}`); await atomicWrite(tasks.path, revisedTasks.text); await client.validate(change); h.panel({ kind: "solo", command: "refine", ok: true, prompt: change }, `REFINE: READY\n\nDesign: ${design.path}\nTasks: ${tasks.path}\n\nStrict validation passed.`);
			h.panel({ kind: "solo", command: "refine", ok: true, prompt: change, agent: { role: revisedTasks.role, model: revisedTasks.model, slotId: architect.id, slotName: architect.name, color: architect.color, primary: architect.primary, status: revisedTasks.status, ms: revisedTasks.ms, tokensIn: revisedTasks.tokensIn, tokensOut: revisedTasks.tokensOut, costUsd: revisedTasks.costUsd, toolCalls: revisedTasks.toolCalls, toolNames: revisedTasks.toolNames, toolEvents: revisedTasks.toolEvents, chars: revisedTasks.text.length } }, `REFINE: TASK SYNTHESIS\n\n${revisedTasks.text}`);
		} catch (error) { reportWorkflowError(h, ctx, "refine", change, error); } finally { lease?.release(); ctx.ui.setStatus("fusion-harness", undefined); }
	}});

	pi.registerCommand("implement", { description: "Implement the next or selected OpenSpec phase", handler: async (raw: any, ctx: any) => {
		const parsed = parseChange(raw ?? "", "/implement"); if (!parsed) return ctx.ui.notify("Usage: /implement <change> [next|phase]", "warning"); let lease: WriterLease | undefined;
		if (!requireOpenSpec(h, ctx, "implement", parsed.change)) return;
		try {
			ctx.ui.setStatus("fusion-harness", `implement: loading OpenSpec change ${parsed.change}…`);
			h.panel({ kind: "banner", command: "implement", ok: true, prompt: parsed.change }, `IMPLEMENT: STARTING\n\nLoading the task plan for ${parsed.change}.`);
			const client = clientFor(ctx); await client.validate(parsed.change); const artifact = resolveArtifact(await client.instructions("tasks", parsed.change), "tasks", ctx.cwd, parsed.change); if (!artifact.content) throw new Error(`tasks artifact not found at ${artifact.path}`); const phases = parseTaskPlan(artifact.content); const phase = parsed.phase ? phases.find((item) => item.number === parsed.phase) : phases.find((item) => item.tasks.some((task) => !task.checked)); if (!phase) throw new Error("no incomplete phase remains"); const incomplete = phase.tasks.filter((task) => !task.checked);
			const taskText = incomplete.map((task) => `- ${task.id}: ${task.description}\n  Requirements: ${task.requirements.join(", ") || "see specs"}\n  Scenarios: ${task.scenarios.join(", ") || "see specs"}\n  Verify commands: ${task.verifyCommands.join(", ") || "none"}`).join("\n");
			const context = await readContext(artifact.contextFiles);
			h.panel({ kind: "solo", command: "implement", ok: true, prompt: parsed.change }, `IMPLEMENT: PHASE ${phase.number} — ${phase.title}\n\n${taskText}`);
			ctx.ui.setStatus("fusion-harness", `implement: collaborating on phase ${phase.number}…`);
			lease = acquireWriterLease(ctx.cwd, `/implement ${parsed.change} phase ${phase.number}`);
			await runOpenSpecCollaboratePhase(h, ctx, parsed.change, phase, context);
			for (const task of incomplete) for (const command of task.verifyCommands) { ctx.ui.setStatus("fusion-harness", `implement: verifying ${task.id} with ${command}…`); const commandParts = command.split(/\s+/); const result = await runProc(commandParts[0], commandParts.slice(1), ctx.cwd, 120_000); if (result.code !== 0) throw new Error(`task ${task.id} verification failed:\n${result.output}`); }
			let updated = artifact.content; for (const task of incomplete) updated = updated.replace(new RegExp(`(-\\s*)\\[ \\]\\s+${task.id.replace(".", "\\.")}(\\s+)`), "$1[x]$2"); await atomicWrite(artifact.path, updated); await client.validate(parsed.change); h.panel({ kind: "solo", command: "implement", ok: true, prompt: parsed.change }, `IMPLEMENT: PASS\n\nPhase ${phase.number} — ${phase.title}\nTasks checked: ${incomplete.map((task) => task.id).join(", ")}`);
		} catch (error) { reportWorkflowError(h, ctx, "implement", parsed?.change ?? "", error); } finally { lease?.release(); ctx.ui.setStatus("fusion-harness", undefined); }
	}});

	pi.registerCommand("ship", { description: "Verify and archive a completed OpenSpec change", handler: async (raw: any, ctx: any) => {
		const change = (raw ?? "").trim().split(/\s+/)[0]; if (!change) return ctx.ui.notify("Usage: /ship <change>", "warning");
		if (!requireOpenSpec(h, ctx, "ship", change)) return;
		try {
			const client = clientFor(ctx);
			const artifact = resolveArtifact(await client.instructions("tasks", change), "tasks", ctx.cwd, change);
			const incomplete = parseTaskPlan(artifact.content ?? "").flatMap((phase) => phase.tasks).filter((task) => !task.checked);
			if (incomplete.length) throw new Error(`SHIP BLOCKED: unchecked tasks ${incomplete.map((task) => task.id).join(", ")}`);
			await client.validate(change);
			const verification = await client.verifyIfSupported(change);
			await client.archive(change);
			h.panel({ kind: "solo", command: "ship", ok: true, prompt: change }, verification.supported
				? `SHIP: ARCHIVED\n\n${change}`
				: `SHIP: ARCHIVED\n\n${change}\n\nNote: this OpenSpec version does not support \`verify\`; archive proceeded after strict validation.`);
		} catch (error) {
			reportWorkflowError(h, ctx, "ship", change, error);
		}
	}});
}
