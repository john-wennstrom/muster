import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { AgentGrid, fitLines, liveColumn } from "./ui/agent-columns.ts";
import type { AgentRun } from "../agents/run-record.ts";
import { musterWidgetKey } from "./branding.ts";

export type AgentRunObserver = (run: AgentRun) => void;

export function agentUsageLine(run: AgentRun): string {
  const cost = run.costReported || run.costUsd > 0 ? `~$${run.costUsd.toFixed(4)}` : "cost unavailable";
  return `${run.tokensIn.toLocaleString("en-US")} input + ${run.tokensOut.toLocaleString("en-US")} output tokens · ${cost}`;
}

/** Observe the same mutable runs the JSON child stream updates; never use host-model stats. */
export function createAgentProgress(options: {
  command: string;
  ui: Pick<ExtensionUIContext, "notify"> & Partial<Pick<ExtensionUIContext, "setWidget">>;
  sendMessage(content: string): void;
}) {
  const key = musterWidgetKey("progress");
  const runs: AgentRun[] = [];
  let ticker: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const render = () => {
    try {
      options.ui.setWidget?.(key, (_tui, theme) => ({
        render(width: number) {
          const active = runs.filter((run) => run.status === "pending" || run.status === "working");
          const visible = active.length ? active : runs.slice(-5);
          const lines = [`MUSTER · /change ${options.command}`];
          // AgentGrid supports five columns; later tasks must remain visible too.
          for (let offset = 0; offset < visible.length; offset += 5) {
            const group = visible.slice(offset, offset + 5);
            const grid = new AgentGrid(group.length, (index, columnWidth) => {
              const run = group[index]!;
              return [
                ...liveColumn(theme, run, columnWidth),
                theme.fg("dim", run.model),
                theme.fg("dim", agentUsageLine(run)),
              ];
            });
            lines.push(...grid.render(width));
          }
          return fitLines(lines, width);
        },
        invalidate() {},
      }), { placement: "aboveEditor" });
    } catch {
      // Rendering is best effort in non-interactive hosts and during shutdown.
    }
  };
  return {
    observe: ((run) => {
      if (closed || runs.includes(run)) return;
      runs.push(run);
      options.ui.notify(`Starting ${run.role}${run.slot ? ` · ${run.slot.name}` : ""} · ${run.model}`, "info");
      render();
      if (!ticker && options.ui.setWidget) {
        ticker = setInterval(render, 250);
        ticker.unref();
      }
    }) satisfies AgentRunObserver,
    finish() {
      if (closed) return;
      closed = true;
      if (ticker) clearInterval(ticker);
      try { options.ui.setWidget?.(key, undefined); } catch { /* host closed */ }
      if (!runs.length) return;
      options.sendMessage([
        `Agent usage · /change ${options.command}`,
        "",
        ...runs.map((run) => {
          const elapsed = run.startedAt ? (run.endedAt ?? Date.now()) - run.startedAt : run.ms;
          return `- ${run.role}${run.slot ? ` · ${run.slot.name}` : ""} · ${run.model} · ${run.status} · ${Math.round(elapsed / 1000)}s · ${agentUsageLine(run)}`;
        }),
      ].join("\n"));
    },
  };
}
