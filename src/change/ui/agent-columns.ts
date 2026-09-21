import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { HexColor, ModelSlot } from "../../agents/model-stack.ts";
import { runError, runTps, toStat, type AgentRun, type AgentStat, type ChildStatus, type Role } from "../../agents/run-record.ts";

export const WIDGET_FLOW_LINES = 8; // live streaming lines shown per column
export const MIN_AGENT_COLUMN_WIDTH = 34;

/** One consistent color per role, everywhere (columns, footer, panels, errors). */
export const ROLE_COLOR: Record<Role, "accent" | "warning" | "success" | "mdLink"> = {
  ARCHITECT: "accent",
  BUILDER: "warning",
  FUSION: "success",
  REVIEWER: "mdLink",
  VALIDATOR: "mdLink",
};

/** One consistent glyph per role, paired with the color above. */
export const ROLE_GLYPH: Record<Role, string> = {
  ARCHITECT: "◆",
  BUILDER: "▲",
  FUSION: "⧉",
  REVIEWER: "◇",
  VALIDATOR: "✓",
};

/** Render an actual configured #RRGGBB slot color without consuming a pi theme token. */
export function fgHex(color: HexColor, text: string): string {
  const value = color.slice(1);
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** One glyph per child status, used in state lines and stat rows. */
export const STATUS_GLYPH: Record<ChildStatus, string> = {
  pending: "○",
  working: "◐",
  done: "✓",
  failed: "✗",
  timeout: "✗",
  aborted: "⊘",
};

/** 12345 → "12.3s" */
export function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 12345 → "12.3k" (token counts) */
export function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** Display-width model name: provider stripped, ellipsized past 24 chars (labels only — never paths). */
export function shortModel(m: string): string {
  const seg = m.split("/").pop() ?? m;
  return seg.length > 24 ? `${seg.slice(0, 23)}…` : seg;
}

/**
 * Labeled one-stat-per-line block for NARROW side-by-side columns, where the compact
 * line truncates: `TIME: 12.3s` / `TOKENS IN: 1.2k` / … Only present values render.
 */
export function statLines(s: AgentStat): string[] {
  const lines = [`TIME: ${fmtSecs(s.ms)}`];
  if (s.tokensIn) lines.push(`TOKENS IN: ${fmtK(s.tokensIn)}`);
  if (s.tokensOut) lines.push(`TOKENS OUT: ${fmtK(s.tokensOut)}`);
  if (s.tps) lines.push(`TPS: ${Math.round(s.tps)}`);
  if (s.toolCalls) lines.push(`TOOLS: ${s.toolCalls}`);
  if (s.costUsd) lines.push(`COST: $${s.costUsd.toFixed(4)}`);
  return lines;
}

export interface AgentGridLayout {
  stacked: boolean;
  columnWidth: number;
  count: number;
  gutterWidth: number;
}

export function computeAgentGridLayout(
  width: number,
  countInput: number,
  gutterWidth = 3,
  minimumColumnWidth = MIN_AGENT_COLUMN_WIDTH,
): AgentGridLayout {
  const count = Math.max(1, Math.min(5, Math.trunc(countInput) || 1));
  const safeWidth = Math.max(1, Math.trunc(width) || 1);
  const safeGutter = Math.max(0, Math.trunc(gutterWidth) || 0);
  const columnWidth = Math.floor((safeWidth - safeGutter * (count - 1)) / count);
  return {
    stacked: count === 1 || columnWidth < minimumColumnWidth,
    columnWidth: Math.max(1, columnWidth),
    count,
    gutterWidth: safeGutter,
  };
}

/** Hard clamp: pi throws on any rendered line wider than the terminal, so every line we emit must fit. */
export function fitLines(lines: string[], width: number): string[] {
  const w = Math.max(1, width);
  return lines.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
}

/** Responsive 1-5 agent grid. If any column would be narrower than 34 cells, stack vertically. */
export class AgentGrid {
  constructor(
    private count: number,
    private build: (index: number, colW: number, stacked: boolean) => string[],
    private gutter: string = " │ ",
  ) {}
  render(width: number): string[] {
    const layout = computeAgentGridLayout(width, this.count, visibleWidth(this.gutter));
    const count = layout.count;
    const colW = layout.columnWidth;
    if (layout.stacked) {
      const blocks = Array.from({ length: count }, (_, index) => fitLines(this.build(index, Math.max(20, width), true), width));
      return blocks.flatMap((block, index) => (index === blocks.length - 1 ? block : [...block, ""]));
    }
    const columns = Array.from({ length: count }, (_, index) => this.build(index, colW, false));
    const rows = Math.max(...columns.map((column) => column.length), 0);
    const out: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = "";
      for (let column = 0; column < count; column++) {
        const value = truncateToWidth(columns[column][row] ?? "", colW);
        line += value;
        if (column < count - 1) line += " ".repeat(Math.max(0, colW - visibleWidth(value))) + this.gutter;
      }
      out.push(line);
    }
    return fitLines(out, width);
  }
  invalidate() {}
}

/** Wrap possibly-styled text to a column width, defensively. */
export function wrapCol(text: string, colW: number): string[] {
  try {
    return wrapTextWithAnsi(text, Math.max(10, colW));
  } catch {
    return text.split("\n");
  }
}

/** `◆ ARCHITECT | name | model` — the role-colored label that opens every column and cell. */
export const roleLabelStr = (theme: any, role: Role, model: string, bold = true, sep = " | ", slot?: ModelSlot) => {
  const roleName = slot && (role === "ARCHITECT" || role === "BUILDER") ? (slot.architect ? "ARCHITECT" : "BUILDER") : role;
  const label = `${ROLE_GLYPH[role]} ${roleName}${slot ? ` | ${slot.name}` : ""}`;
  if (slot) return fgHex(slot.color, bold ? theme.bold(label) : label) + theme.fg("dim", sep) + fgHex(slot.color, shortModel(model));
  return theme.fg(ROLE_COLOR[role], bold ? theme.bold(label) : label) + theme.fg("dim", sep) + theme.fg(ROLE_COLOR[role], shortModel(model));
};

/** One agent's live column: label, state line, then its flow tail (tools + streaming text). */
export const liveColumn = (theme: any, r: AgentRun | undefined, colW: number): string[] => {
  if (!r) return [];
  const now = Date.now();
  const elapsed = r.startedAt ? (r.endedAt ?? now) - r.startedAt : 0;
  const state =
    r.status === "pending" ? "waiting" : r.status === "working" ? `working ${Math.floor(elapsed / 1000)}s` : `${r.status} ${fmtSecs(elapsed)}`;
  const stateColor = r.status === "done" ? "success" : r.status === "working" ? ROLE_COLOR[r.role] : r.status === "pending" ? "dim" : "error";
  const bits = [`${STATUS_GLYPH[r.status]} ${state}`];
  if (r.tokensIn || r.tokensOut) bits.push(`in ${fmtK(r.tokensIn)} out ${fmtK(r.tokensOut)}`);
  const tps = runTps(r);
  if (tps) bits.push(`${Math.round(tps)} tps`);
  if (r.costUsd) bits.push(`$${r.costUsd.toFixed(4)}`);
  const lines: string[] = [roleLabelStr(theme, r.role, r.model, true, " | ", r.slot), theme.fg(stateColor, bits.join(" · "))];

  // DONE agents collapse to a labeled stat block (one value per line — narrow columns
  // truncate the compact form) — the full output lives in the transcript panel;
  // re-streaming it here would duplicate what's already shown.
  if (r.status === "done") {
    const stats = statLines(toStat(r)).map((line, index) => theme.fg("success", index === 0 ? `${STATUS_GLYPH.done} ${line}` : `  ${line}`));
    return [lines[0], ...stats];
  }
  if (r.status === "failed" || r.status === "timeout") {
    lines.push(theme.fg("error", `✗ ${runError(r)}`));
    return lines;
  }

  // WORKING agents stream only the CURRENT spawn's flow (from flowMark) — never
  // stale text from earlier rounds — plus the in-flight message text.
  // Three visually distinct flows, same right-facing-triangle family:
  //   ▸ solid + toolTitle    → tool calls (what it DID)
  //   ▹ hollow + thinkingText italic → reasoning (what it's THINKING) — pi's own thinking
  //     color/italic, so it tracks the theme instead of a hardcoded purple
  //   plain muted/text       → its answer
  const thinkLines = (text: string): string[] =>
    wrapCol(text, colW).map((l, i) => theme.italic(theme.fg("thinkingText", i === 0 ? `▹ ${l}` : `  ${l}`)));
  const flowLines: string[] = [];
  for (const item of r.flow.slice(r.flowMark).slice(-6)) {
    if (item.type === "tool") flowLines.push(theme.fg("toolTitle", `▸ ${item.label}`));
    else if (item.type === "thinking") flowLines.push(...thinkLines(item.text));
    else for (const l of wrapCol(item.text, colW)) flowLines.push(theme.fg("muted", l));
  }
  // Reasoning stays on screen for the WHOLE turn, above the answer it produced — the same
  // order the model emits them. (Hiding it as soon as text starts made it near-invisible:
  // a turn can stream its whole reasoning between two 1s widget ticks.)
  if (r.streamThinking) flowLines.push(...thinkLines(r.streamThinking));
  if (r.streamText) for (const l of wrapCol(r.streamText, colW)) flowLines.push(theme.fg("text", l));
  lines.push(...flowLines.slice(-WIDGET_FLOW_LINES));
  return lines;
};
