import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  brokeredChildRuntime,
  startChildBrokerServer,
} from "../../src/agents/child-runner.ts";
import {
  registerChildBrokerTools,
  requestChildBroker,
  type ChildBrokerConfiguration,
} from "../../src/muster/child-broker.ts";
import { authorizeToolRequest } from "../../src/tools/authorization.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("clean-room child tool boundary", () => {
  test("registers only brokered role tools and no built-in mutation or shell tools", () => {
    const registered: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) { registered.push(tool.name); },
    } as Pick<ExtensionAPI, "registerTool">;
    const base: ChildBrokerConfiguration = {
      host: "127.0.0.1",
      port: 1,
      authToken: "x".repeat(32),
      runId: "run-1",
      childId: "child-1",
      taskId: "7.5",
      role: "reviewer",
      writeEnabled: false,
      toolMode: "brokered",
    };

    registerChildBrokerTools(pi, base, async () => null);
    expect(registered).toEqual(["muster_read", "muster_search"]);
    expect(brokeredChildRuntime("reviewer").tools).toEqual(registered);
    expect(brokeredChildRuntime("builder").tools).toEqual([
      "muster_read",
      "muster_search",
      "muster_write",
      "muster_command",
    ]);
    expect(brokeredChildRuntime("builder").tools).not.toContain("bash");
    expect(brokeredChildRuntime("builder").tools).not.toContain("write");
    expect(brokeredChildRuntime("architect", true).tools).toEqual([
      "muster_read",
      "muster_search",
      "muster_submit_scope",
      "muster_write",
      "muster_command",
    ]);
    expect(brokeredChildRuntime("reviewer", true).tools).toEqual(["muster_read", "muster_search"]);
    expect(brokeredChildRuntime("validator", true).tools).toEqual([
      "muster_read",
      "muster_search",
      "muster_submit_gate",
    ]);
  });

  test("denies a forged reviewer write at the parent before filesystem mutation", async () => {
    const worktreePath = await mkdtemp(resolve(tmpdir(), "muster-child-boundary-"));
    temporaryDirectories.push(worktreePath);
    const targetPath = resolve(worktreePath, "target.txt");
    await writeFile(targetPath, "before\n");
    const broker = await startChildBrokerServer({
      runId: "run-1",
      childId: "reviewer-1",
      taskId: "7.5",
      handleRequest: async (request) => {
        const input = request.input as { path: string; content?: string };
        const decision = await authorizeToolRequest({
          role: "reviewer",
          runId: "run-1",
          childId: "reviewer-1",
          taskId: "7.5",
          taskState: "running",
          repositoryId: "repository-1",
          worktreePath,
          readScopes: ["**"],
          writeScopes: ["**"],
          writerLease: null,
        }, {
          tool: request.tool,
          targetPath: input.path,
          correlationId: request.correlationId,
          requestBytes: 100,
        });
        if (!decision.allowed) throw new Error(decision.reason);
        await writeFile(resolve(worktreePath, input.path), input.content ?? "");
        return { written: true };
      },
    });
    const configuration: ChildBrokerConfiguration = {
      ...broker.identity,
      host: "127.0.0.1",
      port: broker.port,
      role: "reviewer",
      writeEnabled: false,
    };

    try {
      await expect(requestChildBroker(configuration, "write_file", {
        path: "target.txt",
        content: "after\n",
      })).rejects.toThrow(/read-only/);
      expect(await readFile(targetPath, "utf8")).toBe("before\n");
    } finally {
      await broker.close();
    }
  });
});
