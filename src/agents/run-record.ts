import type { HexColor, ModelSlot } from "./model-stack.ts";

export type Role = "ARCHITECT" | "BUILDER" | "FUSION" | "REVIEWER" | "VALIDATOR";

/** Lifecycle of one spawned child agent, from queued to settled. */
export type ChildStatus = "pending" | "working" | "done" | "failed" | "timeout" | "aborted";

/** One entry in an agent's transcript flow: a tool call, a finished text block, or a reasoning block. */
export type FlowItem = { type: "tool"; label: string } | { type: "text"; text: string } | { type: "thinking"; text: string };

/** Live + final view of one child agent. Mutated in place as JSON events stream in. */
export interface AgentRun {
  role: Role;
  model: string;
  slot?: ModelSlot;
  status: ChildStatus;
  startedAt?: number;
  endedAt?: number;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  costReported?: boolean; // distinguish a provider-reported zero from missing pricing
  toolCalls: number;
  toolNames: string[];
  toolEvents: Array<{ name: string; argument: string }>;
  ctxTokens: number; // context used by the last request (for the footer bar)
  // TPS accounting (see the tps extension's semantics): output tokens over observed
  // provider-response seconds. For a child, a "response" segment runs from spawn (or
  // the last tool_execution_end) to an assistant message_end that carried output
  // tokens — network/retries/thinking included, tool execution excluded.
  tpsSeconds: number; // accumulated provider-response seconds across this run's turns
  tpsSegmentStart?: number; // performance.now() at the current segment's start (transient)
  thinking?: string;
  flow: FlowItem[]; // the agent's transcript flow: tool lines + finished text blocks
  flowMark: number; // flow index at the current spawn — the widget only shows flow from HERE (no stale rounds)
  sessionRef?: string; // the child's own session id (from its "session" event) — lets later rounds resume it
  streamText: string; // text of the in-flight assistant message
  streamThinking: string; // reasoning of the in-flight assistant message (rendered live — proof of life)
  text: string;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
}

/** Serializable per-agent stats for message details / artifacts. */
export interface AgentStat {
  role: Role;
  model: string;
  slotId?: string;
  slotName?: string;
  color?: HexColor;
  primary?: boolean;
  architect?: boolean;
  status: ChildStatus;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  toolCalls: number;
  toolNames: string[];
  toolEvents: Array<{ name: string; argument: string }>;
  tps?: number; // observed output tokens/second for this run (throughput-weighted)
  chars: number;
  error?: string;
}

/** A fresh AgentRun in its zero state — mutated in place by runChild as events stream. */
export function newRun(role: Role, model: string, slot?: ModelSlot): AgentRun {
  return {
    role,
    model,
    slot,
    status: "pending",
    ms: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    toolCalls: 0,
    toolNames: [],
    toolEvents: [],
    ctxTokens: 0,
    tpsSeconds: 0,
    streamThinking: "",
    flow: [],
    flowMark: 0,
    streamText: "",
    text: "",
    exitCode: 0,
    stderr: "",
  };
}

/** Success = clean exit ∧ clean stop reason ∧ nonempty answer. */
export function runOk(r: AgentRun): boolean {
  return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted" && r.text.trim().length > 0;
}

/** The most specific failure description available, in priority order. */
export function runError(r: AgentRun): string {
  return (
    (r.status === "aborted" ? "stopped by user (escape)" : "") ||
    r.errorMessage ||
    (r.status === "timeout" || r.exitCode === 124 ? "timed out" : "") ||
    r.stderr.trim().slice(-300) ||
    (r.text.trim() ? "" : "no output") ||
    `exit ${r.exitCode}`
  );
}

/**
 * Observed output tokens/second for a run: Σ output tokens ÷ Σ provider-response
 * seconds (throughput-weighted, never a mean of per-turn readings). Undefined until
 * both are nonzero — no division-by-zero readouts.
 */
export function runTps(r: AgentRun): number | undefined {
  return r.tokensOut > 0 && r.tpsSeconds > 0 ? r.tokensOut / r.tpsSeconds : undefined;
}

/** Freeze a live AgentRun into the serializable stat used by panels and summary.json. */
export function toStat(r: AgentRun): AgentStat {
  return {
    role: r.role,
    model: r.model,
    slotId: r.slot?.id,
    slotName: r.slot?.name,
    color: r.slot?.color,
    primary: r.slot?.primary,
    architect: r.slot?.architect,
    status: r.status,
    ms: r.ms,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    costUsd: r.costUsd,
    toolCalls: r.toolCalls,
    toolNames: [...r.toolNames],
    toolEvents: r.toolEvents.map((event) => ({ ...event })),
    tps: runTps(r),
    chars: r.text.length,
    error: runOk(r) ? undefined : runError(r),
  };
}

/**
 * A tool call's argument, condensed for one flow line.
 *
 * The cap here is a MEMORY bound, not a layout one — it must stay far wider than any
 * column so a wide terminal shows a wide line. Fitting is the renderer's job: TwoCol
 * (`truncateToWidth` per column) and `FullWidth` (`fitLines`) clamp to the real width at
 * render, which is what actually keeps pi from throwing on an over-wide line. Capping at
 * capture instead trimmed every view to the narrowest one it might ever be drawn in.
 */
const TOOL_ARG_MAX = 200;
export function briefArg(args: any): string {
  if (!args || typeof args !== "object") return "";
  const v =
    args.path ?? args.file_path ?? args.filePath ?? args.pattern ?? args.command ?? Object.values(args).find((x) => typeof x === "string");
  if (typeof v !== "string" || !v) return "";
  const s = v.includes("/") && !v.includes(" ") ? v.split("/").slice(-2).join("/") : v;
  return s.replace(/\s+/g, " ").slice(0, TOOL_ARG_MAX);
}
