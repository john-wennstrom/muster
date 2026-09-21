import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { newRun } from "../../src/agents/run-record.ts";
import { AgentGrid, liveColumn } from "../../src/change/ui/agent-columns.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };

describe("agent columns", () => {
  test("two live columns render side by side from two agent runs", () => {
    const builder = newRun("BUILDER", "openai/gpt-test");
    builder.status = "working";
    builder.startedAt = Date.now();
    builder.flow.push({ type: "tool", label: "read src/a.ts" });
    const reviewer = newRun("REVIEWER", "anthropic/claude-test");
    reviewer.status = "failed";
    reviewer.errorMessage = "provider refused";

    const runs = [builder, reviewer];
    const grid = new AgentGrid(runs.length, (index, columnWidth) => liveColumn(theme, runs[index], columnWidth));
    const lines = grid.render(160);

    expect(lines.some((line) => line.includes("BUILDER") && line.includes("REVIEWER"))).toBeTrue();
    expect(lines.join("\n")).toContain("read src/a.ts");
    expect(lines.join("\n")).toContain("provider refused");
    expect(lines.every((line) => visibleWidth(line) <= 160)).toBeTrue();
  });

  test("narrow terminals stack the columns and never overflow", () => {
    const runs = [newRun("BUILDER", "a/b"), newRun("REVIEWER", "c/d")];
    const grid = new AgentGrid(2, (index, columnWidth) => liveColumn(theme, runs[index], columnWidth));
    const lines = grid.render(40);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBeTrue();
    expect(lines.filter((line) => line.includes("BUILDER"))).toHaveLength(1);
  });

  test("the module does not depend on the retired extension", async () => {
    const source = await readFile(resolve(import.meta.dir, "../../src/change/ui/agent-columns.ts"), "utf8");
    expect(source).not.toContain("extensions/");
  });
});
