import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { newRun } from "../../extensions/fusion-harness/modules/runtime.ts";
import { createAgentProgress, agentUsageLine } from "../../src/muster/agent-progress.ts";
import { registerChangeCommand } from "../../src/muster/change-command.ts";
import { createProductionChangeCommandDependencies, createProductionExploreDependencies } from "../../src/muster/production-runtime.ts";
import { runProcess } from "../../src/shared/process.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function uiHarness() {
  const frames: string[] = [];
  const notifications: string[] = [];
  const cleared: string[] = [];
  const overflow: string[] = [];
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };
  const ui = {
    notify(message: string) { notifications.push(message); },
    setWidget(key: string, content: unknown) {
      if (!content) { cleared.push(key); return; }
      if (typeof content === "function") {
        const component = content({}, theme);
        frames.push(component.render(180).join("\n"));
        for (const width of [1, 20, 80]) {
          overflow.push(...component.render(width).filter((line: string) => visibleWidth(line) > width));
        }
      }
    },
  } as unknown as ExtensionUIContext;
  return { ui, frames, notifications, cleared, overflow };
}

describe("change agent progress", () => {
  test("real child JSON reaches the widget before completion and leaves model-specific usage", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-progress-"));
    directories.push(root);
    expect((await runProcess("git", ["init"], { cwd: root, timeoutMs: 10_000 })).exitCode).toBe(0);
    // A deterministic pi stand-in exercises the actual spawn, JSON parser, broker,
    // production dependencies, command registration and widget without a model API call.
    const child = resolve(root, "child.mjs");
    await writeFile(child, `
      const tools = process.argv[process.argv.indexOf("--tools") + 1].split(",");
      if (!["read", "grep", "find", "ls"].every((tool) => tools.includes(tool)) || tools.includes("muster_read")) process.exit(2);
      const emit = (event) => console.log(JSON.stringify(event));
      emit({type: "message_update", message: {role: "assistant", content: [{type: "text", text: "Inspecting employee skills"}]}});
      emit({type: "message_end", message: {role: "assistant", provider: "fixture", model: "resolved-model", content: [{type: "text", text: "Inspecting employee skills"}], usage: {input: 2, cacheRead: 10, cacheWrite: 1388, output: 217, cost: {total: 0.005644}}}});
      emit({type: "tool_execution_start", toolName: "grep", args: {pattern: "skill"}});
      setTimeout(() => {
        emit({type: "message_end", message: {role: "assistant", provider: "fixture", model: "resolved-model", content: [{type: "text", text: "Final skill analysis"}], stopReason: "stop", usage: {input: 5, output: 20, cost: {total: 0.001}}}});
      }, 700);
    `);
    const subject = uiHarness();
    const messages: string[] = [];
    let handler!: (args: string, context: ExtensionCommandContext) => Promise<void>;
    registerChangeCommand({
      registerCommand(_name, command) { handler = command.handler; },
      sendMessage(message) { messages.push(String(message.content)); },
    } as Pick<ExtensionAPI, "registerCommand" | "sendMessage">, createProductionChangeCommandDependencies({
      cwd: root, argv: ["--architect", "fixture/requested-model"],
    }));
    const entry = process.argv[1];
    try {
      process.argv[1] = child;
      await handler("explore employee skills", { cwd: root, ui: subject.ui } as ExtensionCommandContext);
    } finally {
      process.argv[1] = entry!;
    }
    expect(subject.notifications.join("\n")).toContain("Starting ARCHITECT");
    expect(subject.frames.some((frame) => frame.includes("working") && frame.includes("grep"))).toBe(true);
    expect(subject.frames.some((frame) => frame.includes("1,400 input + 217 output tokens") && frame.includes("~$0.0056"))).toBe(true);
    expect(subject.frames.some((frame) => frame.includes("fixture/resolved-model"))).toBe(true);
    expect(messages.some((message) => message.includes("Final skill analysis"))).toBe(true);
    expect(messages.at(-1)).toContain("1,405 input + 237 output tokens · ~$0.0066");
    expect(messages.at(-1)).toContain("fixture/resolved-model · done");
    expect(subject.cleared).toHaveLength(1);
    expect(subject.overflow).toEqual([]);
  });

  test("multiple slots keep separate statistics and cleanup is idempotent", () => {
    const subject = uiHarness();
    const messages: string[] = [];
    const progress = createAgentProgress({ command: "propose", ui: subject.ui, sendMessage: (message) => messages.push(message) });
    const architect = newRun("ARCHITECT", "provider/architect");
    const builder = newRun("BUILDER", "provider/builder");
    progress.observe(architect);
    progress.observe(builder);
    progress.observe(architect);
    architect.tokensIn = 100;
    architect.costUsd = 0.02;
    builder.tokensOut = 50;
    builder.status = "aborted";
    progress.finish();
    progress.finish();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("100 input + 0 output tokens · ~$0.0200");
    expect(messages[0]).toContain("0 input + 50 output tokens · cost unavailable");
    expect(messages[0]).toContain("provider/builder · aborted");
    expect(subject.cleared).toHaveLength(1);
  });

  test("missing pricing is distinct from a reported zero cost", () => {
    const run = newRun("ARCHITECT", "provider/model");
    expect(agentUsageLine(run)).toContain("cost unavailable");
    run.costReported = true;
    expect(agentUsageLine(run)).toContain("~$0.0000");
  });

  test("later agents remain visible after the first five invocations", () => {
    const subject = uiHarness();
    const progress = createAgentProgress({ command: "implement", ui: subject.ui, sendMessage() {} });
    try {
      for (let index = 0; index < 7; index++) {
        const run = newRun("BUILDER", `provider/task-${index}`);
        progress.observe(run);
        run.status = "done";
      }
      expect(subject.frames.at(-1)).toContain("provider/task-6");
    } finally {
      progress.finish();
    }
  });

  test("command failure clears live widgets and retains completed usage", async () => {
    const subject = uiHarness();
    const messages: string[] = [];
    let handler!: (args: string, context: ExtensionCommandContext) => Promise<void>;
    registerChangeCommand({
      registerCommand(_name, command) { handler = command.handler; },
      sendMessage(message) { messages.push(String(message.content)); },
    } as Pick<ExtensionAPI, "registerCommand" | "sendMessage">, {
      resolveChangeName: async () => null,
      loadSnapshot: async () => null,
      handlers: {
        explore: async (_command, context) => {
          const run = newRun("ARCHITECT", "fixture/failed");
          context.onAgentStart?.(run);
          run.tokensOut = 25;
          run.status = "failed";
          throw new Error("Provider unavailable");
        },
      },
    });
    await handler("explore skills", { ui: subject.ui } as ExtensionCommandContext);
    expect(messages[0]).toContain("Provider unavailable");
    expect(messages[1]).toContain("fixture/failed · failed");
    expect(messages[1]).toContain("25 output tokens");
    expect(subject.cleared).toHaveLength(1);
  });

  test("explore uses slot configuration and propagates cancellation", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-progress-"));
    directories.push(root);
    const config = resolve(root, "models.yaml");
    await writeFile(config, "slots:\n  - name: Design\n    model: fixture/architect\n    architect: true\n    thinking: xhigh\n  - name: Build\n    model: fixture/builder\n    primary: true\n");
    const signal = new AbortController().signal;
    let observed = false;
    const deps = createProductionExploreDependencies(root, signal, {
      argv: ["--fh-config", config],
      onAgentStart: () => { observed = true; },
      runChild: async (options) => {
        expect(options.thinking).toBe("xhigh");
        expect(options.run.slot?.name).toBe("Design");
        expect(options.signal).toBe(signal);
        options.onAgentStart?.(options.run);
        options.run.status = "aborted";
        return options.run;
      },
    });
    await expect(deps.runAgent({ phase: "explore", access: "read", prompt: "skills", authoritativeContext: {}, supplementalFacts: [] })).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
    expect(observed).toBe(true);
  });
});
