/**
 * runtime.ts — the harness's shared vocabulary.
 *
 * Everything here is a data type, a constant, or a pure function: roles and their
 * glyphs/colors, the AgentRun lifecycle (live child state → serializable AgentStat),
 * the FhDetails panel contract, tool allowlists, and the small formatting helpers
 * every other module leans on. No pi APIs, no processes, no filesystem.
 */

import type { ChildAccess, ResolvedChildRuntime } from "../../../src/agents/child-runtime.ts";
import type { HexColor, ModelSlot, ModelStack, Thinking } from "../../../src/agents/model-stack.ts";
import type { AgentRun, AgentStat, ChildStatus, Role } from "../../../src/agents/run-record.ts";
import { fmtK, fmtSecs } from "../../../src/change/ui/agent-columns.ts";

export { briefArg } from "../../../src/agents/run-record.ts";
export { fgHex, fmtK, fmtSecs, ROLE_COLOR, ROLE_GLYPH, shortModel, STATUS_GLYPH, statLines } from "../../../src/change/ui/agent-columns.ts";

// ═══ Shared limits ═══════════════════════════════════════════════════════════

export const ANSWER_MAX_BYTES = 100_000; // cap any rendered agent answer
export const DETAIL_SNIPPET_MAX = 4_000; // chars of script/output kept in message details
export const GATE_TIMEOUT_MS = 120_000; // `uv run` of the validation gate

export const CUSTOM_TYPE = "fusion-harness"; // customType tag on every panel/widget/status this extension emits
export const BOOT_TYPE = "fusion-harness-boot"; // the boot banner's own tag — a session ENTRY, never an LLM-context message

// ═══ Roles ═══════════════════════════════════════════════════════════════════

// ═══ Run lifecycle types ═════════════════════════════════════════════════════

/** The renderer's discriminated payload — one shape per panel `kind`, carried on every custom message. */
export interface FhDetails {
	kind:
		| "prompt"
		| "banner"
		| "duo"
		| "multi"
		| "sync"
		| "stopped"
		| "fused"
		| "opinion"
		| "gate"
		| "validation"
		| "triage"
		| "error"
		| "system-prompt"
		| "solo" // /fh-only — one selected agent, one full-width answer
		| "closing" // /fh-debate — the final round: two closing statements, side by side
		| "collab"; // /fh-collaborate — the shared deliverable after the last turn
	command?: string; // the slash command that produced this panel ("fh-fusion", …)
	title?: string; // duo panels: what THIS pair of columns is (e.g. "round 2 — rebuttals")
	ok: boolean;
	round?: number; // auto-validate: which build→validate round this panel reports
	maxRounds?: number; // auto-validate: the --max-validations cap
	escalateAt?: number; // auto-validate: the --escalate-to-validator-count threshold
	prompt?: string;
	fusionPrompt?: string;
	roles?: Array<{ role: Role; model: string; slotId?: string; slotName?: string; color?: HexColor; primary?: boolean; architect?: boolean }>;
	agent?: AgentStat; // fused: the fuser · validation: the validator
	sources?: AgentStat[]; // the two columns' stats (left, right)
	answers?: Array<{ role: Role; model: string; text: string; slotId?: string; slotName?: string; color?: HexColor; primary?: boolean }>; // agent bodies in display order
	script?: string; // validation gate (truncated for details)
	gateOutput?: string;
	gateExitCode?: number;
	scriptPath?: string;
	artifactsDir?: string;
	totalMs?: number;
	totalCostUsd?: number;
	error?: string;
}

// ═══ Formatting helpers ══════════════════════════════════════════════════════

/** Truncate by character count, with an explicit elision marker (prompt handoffs). */
export function truncateChars(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n… [truncated — ${s.length - max} chars elided]`;
}

/** Truncate by UTF-8 byte count (panel bodies — pi caps message size in bytes). */
export function truncateBytes(s: string, max: number): string {
	const buf = Buffer.from(s, "utf-8");
	if (buf.length <= max) return s;
	return `${buf.subarray(0, max).toString("utf-8")}\n\n… [truncated — ${buf.length - max} bytes elided]`;
}

export function splitUtf8(text: string, maxBytes: number): string[] {
	const chunks: string[] = [];
	let current = "";
	let bytes = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (current && bytes + size > maxBytes) {
			chunks.push(current);
			current = "";
			bytes = 0;
		}
		current += char;
		bytes += size;
	}
	if (current || !chunks.length) chunks.push(current);
	return chunks;
}

/**
 * Filename-safe model tag: provider stripped, anything but [A-Za-z0-9._-] collapsed to `-`.
 * NOT shortModel(): that truncates long ids with a `…`, and these tags land in real paths.
 */
export function modelTag(m: string): string {
	return (m.split("/").pop() ?? m).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

/** Footer-width abbreviations for pi's thinking levels (pi: ModelThinkingLevel). */
export const THINKING_SHORT: Record<string, string> = {
	off: "none",
	minimal: "min",
	low: "low",
	medium: "med",
	high: "hi",
	xhigh: "xhi",
	max: "max",
};
/** ` (med)` — the parenthesized short thinking level appended to a model label. */
export const thinkingTag = (level?: string): string => (level ? ` (${THINKING_SHORT[level] ?? level})` : "");

// ═══ Run lifecycle helpers ═══════════════════════════════════════════════════

/** Compact one-line stats: `12.3s · in 1.2k out 0.4k · 87 tps · 3 tools · $0.0123` — full-width headers only. */
export function statLine(s: AgentStat): string {
	const parts = [fmtSecs(s.ms)];
	if (s.tokensIn || s.tokensOut) parts.push(`in ${fmtK(s.tokensIn)} out ${fmtK(s.tokensOut)}`);
	if (s.tps) parts.push(`${Math.round(s.tps)} tps`);
	if (s.toolCalls) parts.push(`${s.toolCalls} tools`);
	if (s.costUsd) parts.push(`$${s.costUsd.toFixed(4)}`);
	return parts.join(" · ");
}

/** Clamp a user-supplied count to [1, 20], falling back when unparsable. */
export const clampCount = (n: number, fallback: number): number => (Number.isFinite(n) && n >= 1 ? Math.min(20, Math.floor(n)) : fallback);

// ═══ The command modules' contract with the extension factory ════════════════

/** How a child lands in a session: fork the host, resume an earlier child, or pin a persistent id. */
export type SpawnIdentity = { fork?: string; sessionDir: string; sessionId?: string; resume?: string };

/**
 * Everything a command module needs from the extension factory. The factory owns pi
 * wiring, flags/config, persistent sessions, widgets, and panel plumbing; command
 * modules own orchestration logic. Keep this surface explicit — it IS the seam.
 */
export interface HarnessDeps {
	// panels + live widgets
	panel(details: FhDetails, content: string): void;
	stoppedPanel(command: string, runs: AgentRun[], artifactsDir: string, startedAt: number, what: string): void;
	/**
	 * Fold extra runs into the model bar's per-slot memory (context %, tps, cost). The
	 * live widgets absorb the runs they were STARTED with at stop — a command that spawns
	 * additional runs afterward (the fusion ACK turns) must hand them in itself, AFTER its
	 * widget stops, so the remembered per-slot reading ends on the latest session state.
	 */
	absorbRuns(runs: AgentRun[]): void;
	startStoppable(ctx: any, command: string): { signal: AbortSignal; stopped: () => boolean; release: () => void };
	startWidget(ctx: any, command: string, cols: [AgentRun, AgentRun], span: AgentRun | undefined, startedAt: number): () => void;
	startGridWidget(ctx: any, command: string, runs: AgentRun[], span: AgentRun | undefined, startedAt: number): () => void;
	// stack + host
	noteHost(ctx: any): void;
	modelStack(): ModelStack;
	resolveChildRuntime(slot: ModelSlot, access: ChildAccess): ResolvedChildRuntime;
	architectModel(): string;
	builderModel(): string;
	// spawn identities + persistent sessions
	newSlotRun(slot: ModelSlot): AgentRun;
	slotInitialSpawn(slot: ModelSlot, ctx: any, artifactsDir: string): SpawnIdentity;
	slotNextSpawn(slot: ModelSlot, run: AgentRun, initial: SpawnIdentity, ctx: any): SpawnIdentity;
	builderSpawn(ctx: any, artifactsDir: string): SpawnIdentity;
	roleSession(side: "architect" | "builder", cwd: string): { id: string; dir: string };
	roleThinking(side: "architect" | "builder"): Thinking;
	roleSystemPrompt(side: "architect" | "builder"): string | undefined;
	cachedRoleId(side: "architect" | "builder"): string | undefined;
	cachedSlotId(slot: ModelSlot): string | undefined;
	// timeouts + flags
	childTimeoutMs(): number;
	buildTimeoutMs(): number;
	flagStr(name: string): string;
	// artifacts
	mkArtifacts(): Promise<string>;
	save(dir: string, name: string, body: string): Promise<void>;
	ensureSummary(dir: string, payload: Record<string, unknown>): Promise<void>;
	totals(runs: AgentRun[], startedAt: number): { totalMs: number; totalCostUsd: number };
}
