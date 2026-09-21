import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import { newRun } from "../../src/agents/run-record.ts";
import { runProcess } from "../../src/shared/process.ts";
import { runAgent, standardChildRuntime } from "../../src/agents/spawn.ts";
import { registerChildBrokerTools, type ChildBrokerConfiguration } from "../../src/agents/child-broker.ts";
import { promptFor } from "../helpers/prompt.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function stack() {
  return synthesizeLegacyStack({ architectModel: "fixture/architect", builderModel: "fixture/builder", architectThinking: "high", builderThinking: "high" });
}

describe("standard agent tools", () => {
  test("role and task mode select the original native tool sets", () => {
    const run = newRun("ARCHITECT", "fixture/model");
    const read = ["read", "grep", "find", "ls"];
    const write = [...read, "bash", "edit", "write"];
    expect(standardChildRuntime({ run, role: "architect" }).tools).toEqual(read);
    expect(standardChildRuntime({ run, role: "architect", evidenceEnabled: true }).tools).toEqual([...read, "muster_submit_scope"]);
    expect(standardChildRuntime({ run, role: "builder" }).tools).toEqual(write);
    expect(standardChildRuntime({ run, role: "builder", writeEnabled: false }).tools).toEqual(read);
    expect(standardChildRuntime({ run, role: "architect", writeEnabled: true }).tools).toEqual(write);
    expect(standardChildRuntime({ run, role: "reviewer", writeEnabled: true }).tools).toEqual(read);
    expect(standardChildRuntime({ run, role: "validator" }).tools).toEqual([...read, "write"]);
    expect(standardChildRuntime({ run, role: "validator", evidenceEnabled: true }).tools).toEqual([...read, "write", "muster_submit_gate"]);
  });

  test("global and slot extensions and tool inheritance are honored", () => {
    const modelStack = stack();
    modelStack.child = { extensions: ["global.ts"], tools: { read: ["lookup", "obsolete"], write: ["publish"] } };
    const slot = modelStack.primaryBuilder;
    slot.child = { extensions: ["slot.ts"], tools: { read: { inherit: true, include: ["symbols"], exclude: ["obsolete"] } } };
    const run = newRun("BUILDER", slot.model, slot);
    const writer = standardChildRuntime({ run, role: "builder", modelStack });
    expect(writer.extensions).toEqual(["slot.ts"]);
    expect(writer.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "lookup", "symbols", "publish"]);
    const reader = standardChildRuntime({ run, role: "builder", writeEnabled: false, modelStack });
    expect(reader.tools).toEqual(["read", "grep", "find", "ls", "lookup", "symbols"]);
    expect(standardChildRuntime({ run: newRun("ARCHITECT", modelStack.architect.model, modelStack.architect), role: "architect", modelStack }).extensions).toContain("global.ts");
  });

  test("standard mode registers evidence tools without filesystem replacements", () => {
    const names: string[] = [];
    const pi = { registerTool: (tool: { name: string }) => names.push(tool.name) } as Pick<ExtensionAPI, "registerTool">;
    const config: ChildBrokerConfiguration = { host: "127.0.0.1", port: 1, authToken: "x".repeat(32), runId: "run", childId: "child", taskId: "task", role: "architect", writeEnabled: true };
    registerChildBrokerTools(pi, config, async () => null);
    expect(names).toEqual(["muster_submit_scope"]);
    names.length = 0;
    registerChildBrokerTools(pi, { ...config, role: "validator" }, async () => null);
    expect(names).toEqual(["muster_submit_gate"]);
    names.length = 0;
    registerChildBrokerTools(pi, { ...config, role: "builder" }, async () => null);
    expect(names).toEqual([]);
  });

  test("spawn defaults to native tools and preserves explicit brokered mode", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-standard-tools-"));
    directories.push(root);
    expect((await runProcess("git", ["init"], { cwd: root, timeoutMs: 10_000 })).exitCode).toBe(0);
    const entry = resolve(root, "child.mjs");
    await writeFile(entry, `console.log(JSON.stringify({type: "message_end", message: {role: "assistant", stopReason: "stop", content: [{type: "text", text: JSON.stringify({args: process.argv.slice(2), mode: process.env.MUSTER_TOOL_MODE})}]}}));`);
    const originalEntry = process.argv[1];
    try {
      process.argv[1] = entry;
      for (const toolMode of [undefined, "brokered"] as const) {
        const modelStack = stack();
        modelStack.child = { extensions: ["configured.ts"], tools: { read: ["lookup"] } };
        const run = newRun("BUILDER", modelStack.primaryBuilder.model, modelStack.primaryBuilder);
        await runAgent({
          access: "write",
          run,
          modelStack,
          toolMode,
          role: "builder",
          prompt: promptFor("inspect"),
          runId: "test",
          childId: "child",
          task: {
            id: "1.1",
            assignee: "builder",
            description: "inspect",
            depends_on: [],
            outputs: [],
            mode: "write",
            reads: ["**"],
            writes: ["src/**"],
          },
          thinking: "high",
          sessionDir: resolve(root, "sessions"),
          cwd: root,
          timeoutMs: 5_000,
        });
        expect(run.status).toBe("done");
        const result = JSON.parse(run.text) as { args: string[]; mode: string };
        const tools = result.args[result.args.indexOf("--tools") + 1]!.split(",");
        if (toolMode === "brokered") {
          expect(result.mode).toBe("brokered");
          expect(tools).toContain("muster_write");
          expect(tools).not.toContain("bash");
        } else {
          expect(result.mode).toBe("standard");
          expect(tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "lookup"]);
          expect(result.args).toContain("configured.ts");
          expect(tools).not.toContain("muster_read");
        }
      }
    } finally {
      process.argv[1] = originalEntry!;
    }
  });
});
