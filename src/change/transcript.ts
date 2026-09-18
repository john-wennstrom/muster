import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { MUSTER_CUSTOM_TYPE, type MusterChangeDetails } from "./branding.ts";
import type { CommandOutcomeStatus } from "./command.ts";

const STATUS_GLYPH: Readonly<Record<CommandOutcomeStatus, string>> = {
  success: "✓",
  blocked: "◼",
  cancelled: "⊘",
  failure: "✗",
};

const STATUS_COLOR: Readonly<Record<CommandOutcomeStatus, string>> = {
  success: "success",
  blocked: "warning",
  cancelled: "muted",
  failure: "error",
};

function messageText(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

/** Renders a `/change` transcript message as a labelled panel; returns undefined to fall back to pi's default. */
export function renderMusterChangePanel(message: { content: unknown; details?: unknown }, theme: any): any {
  const details = (message.details ?? {}) as Partial<MusterChangeDetails>;
  const content = messageText(message);
  if (!details.action) return undefined;

  const status = details.status ?? "success";
  const container = new Container();
  const heading = `${STATUS_GLYPH[status]} MUSTER · /change ${details.action}${details.changeName ? ` ${details.changeName}` : ""}`;
  container.addChild(new Text(theme.fg(STATUS_COLOR[status], theme.bold(heading)), 1, 0));
  const meta = [status, details.runId, details.code].filter(Boolean).join(" · ");
  if (meta) container.addChild(new Text(theme.fg("muted", `  ${meta}`), 1, 0));
  container.addChild(new Markdown(content || "(no output)", 1, 0, getMarkdownTheme()));
  return container;
}

export const MUSTER_CHANGE_RENDERER = [MUSTER_CUSTOM_TYPE, renderMusterChangePanel] as const;
