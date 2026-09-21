import { connect, type Socket } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrokerClient, type BrokerTransport } from "./broker-client.ts";
import type { BrokerChildRole } from "./broker-server.ts";
import type { BrokerMessage, BrokerPeerIdentity } from "../tools/protocol.ts";

export interface ChildBrokerConfiguration extends BrokerPeerIdentity {
  host: string;
  port: number;
  role: BrokerChildRole;
  writeEnabled: boolean;
  toolMode?: "standard" | "brokered";
}

export type ChildBrokerRequest = (
  tool: string,
  input: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Child broker requires ${name}`);
  return value;
}

export function childBrokerConfigurationFromEnvironment(): ChildBrokerConfiguration {
  const port = Number(requiredEnvironment("MUSTER_BROKER_PORT"));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("Child broker port is invalid");
  }
  const role = requiredEnvironment("MUSTER_BROKER_ROLE");
  if (!["architect", "builder", "reviewer", "validator"].includes(role)) {
    throw new Error("Child broker role is invalid");
  }
  return {
    host: requiredEnvironment("MUSTER_BROKER_HOST"),
    port,
    authToken: requiredEnvironment("MUSTER_BROKER_TOKEN"),
    runId: requiredEnvironment("MUSTER_BROKER_RUN_ID"),
    childId: requiredEnvironment("MUSTER_BROKER_CHILD_ID"),
    taskId: requiredEnvironment("MUSTER_BROKER_TASK_ID"),
    role: role as BrokerChildRole,
    writeEnabled: process.env.MUSTER_BROKER_WRITE_ENABLED === "1",
    toolMode: process.env.MUSTER_TOOL_MODE === "brokered" ? "brokered" : "standard",
  };
}

export async function requestChildBroker(
  configuration: ChildBrokerConfiguration,
  tool: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const socket = connect({ host: configuration.host, port: configuration.port });
  socket.setEncoding("utf8");
  let buffer = "";
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const transport: BrokerTransport = {
    send(message: BrokerMessage) {
      socket.write(`${JSON.stringify(message)}\n`);
    },
  };
  const client = new BrokerClient({ ...configuration, transport });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string };
        if (parsed.type === "broker.ready") {
          client.acceptReady(parsed);
          readyResolve();
        } else {
          client.receive(parsed);
        }
      } catch (error) {
        readyReject(error instanceof Error ? error : new Error(String(error)));
        client.close(error instanceof Error ? error.message : String(error));
        socket.destroy();
      }
    }
  });
  socket.once("error", (error) => {
    readyReject(error);
    client.close(error.message);
  });
  try {
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", resolveConnect);
      socket.once("error", rejectConnect);
    });
    await client.start();
    await ready;
    return await client.request(tool, input, signal);
  } finally {
    client.close();
    socket.destroy();
  }
}

function textResult(output: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof output === "string" ? output : JSON.stringify(output) }],
    details: { brokered: true },
  };
}

export function registerChildBrokerTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  configuration: ChildBrokerConfiguration,
  request: ChildBrokerRequest = (tool, input, signal) => requestChildBroker(configuration, tool, input, signal),
): void {
  if (configuration.toolMode === "brokered") {
    pi.registerTool({
      name: "muster_read",
      label: "Read",
      description: "Read one authorized file through the parent broker.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params, signal) => textResult(await request("read_file", params, signal)),
    });
    pi.registerTool({
      name: "muster_search",
      label: "Search",
      description: "Search literal text in authorized tracked and non-ignored untracked files through the parent broker. Optional path limits the search. Returns up to 200 matching lines; skips binary files, files over 2 MiB, node_modules, and .fusion run logs.",
      parameters: Type.Object({ query: Type.String(), path: Type.Optional(Type.String()) }),
      execute: async (_id, params, signal) => textResult(await request("search", params, signal)),
    });
  }
  if (configuration.role === "architect") {
    pi.registerTool({
      name: "muster_submit_scope",
      label: "Submit Scope",
      description: "Submit bounded repository read/write scopes to the trusted parent for validation.",
      parameters: Type.Object({
        reads: Type.Array(Type.String()),
        writes: Type.Array(Type.String()),
      }),
      execute: async (_id, params, signal) => textResult(await request("submit_scope", params, signal)),
    });
  }
  if (configuration.role === "validator") {
    pi.registerTool({
      name: "muster_submit_gate",
      label: "Submit Gate",
      description: "Submit a validation gate to the trusted parent without filesystem access.",
      parameters: Type.Object({ content: Type.String(), format: Type.Literal("python") }),
      execute: async (_id, params, signal) => textResult(await request("submit_gate", params, signal)),
    });
  }
  if (configuration.toolMode !== "brokered" || !configuration.writeEnabled || configuration.role === "reviewer" || configuration.role === "validator") return;
  pi.registerTool({
    name: "muster_write",
    label: "Write",
    description: "Write an authorized file through the parent broker and active writer lease.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, params, signal) => textResult(await request("write_file", params, signal)),
  });
  pi.registerTool({
    name: "muster_command",
    label: "Command",
    description: "Run an authorized structured command profile through the parent broker.",
    parameters: Type.Object({
      profile: Type.String(),
      executable: Type.String(),
      args: Type.Array(Type.String()),
      cwd: Type.String(),
    }),
    execute: async (_id, params, signal) => textResult(await request("command", params, signal)),
  });
}

export default function registerChildBroker(pi: ExtensionAPI): void {
  registerChildBrokerTools(pi, childBrokerConfigurationFromEnvironment());
}
