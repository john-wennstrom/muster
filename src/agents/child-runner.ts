import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { runChild } from "../../extensions/fusion-harness/modules/child-runner.ts";
import { resolveChildRuntime } from "../../extensions/fusion-harness/modules/runtime.ts";
import type { ModelStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
import type {
  AgentRun,
  ChildAccess,
  ResolvedChildRuntime,
} from "../../extensions/fusion-harness/modules/runtime.ts";
import {
  BROKER_PROTOCOL_VERSION,
  BrokerProtocolError,
  createBrokerAuthToken,
  negotiateBrokerProtocol,
  parseBrokerMessage,
  type BrokerMessage,
  type BrokerPeerIdentity,
} from "../tools/protocol.ts";

export type BrokerChildRole = "architect" | "builder" | "reviewer" | "validator";

export interface BrokerRequestContext {
  correlationId: string;
  tool: string;
  input: unknown;
  signal: AbortSignal;
}

export interface ChildBrokerServerOptions {
  runId: string;
  childId: string;
  taskId: string;
  handleRequest: (request: BrokerRequestContext) => Promise<unknown>;
  maxRequests?: number;
  authToken?: string;
  host?: string;
}

export interface ChildBrokerServer {
  identity: BrokerPeerIdentity;
  environment: NodeJS.ProcessEnv;
  port: number;
  close(): Promise<void>;
}

export interface RunBrokeredChildOptions {
  /** Standard Pi tools are the default; brokered filesystem tools are opt-in. */
  toolMode?: "standard" | "brokered";
  modelStack?: Pick<ModelStack, "child">;
  run: AgentRun;
  prompt: string;
  systemPrompt?: string;
  appendSystemPrompts?: string[];
  role: BrokerChildRole;
  evidenceEnabled?: boolean;
  writeEnabled?: boolean;
  runId: string;
  childId: string;
  taskId: string;
  handleRequest: ChildBrokerServerOptions["handleRequest"];
  maxRequests?: number;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  sessionDir: string;
  sessionId?: string;
  fork?: string;
  resume?: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

const CHILD_BROKER_EXTENSION = fileURLToPath(new URL("./child-broker.ts", import.meta.url));

export function brokeredToolNames(
  role: BrokerChildRole,
  writeEnabled = role === "builder",
  evidenceEnabled = false,
): string[] {
  const tools = ["muster_read", "muster_search"];
  if (evidenceEnabled && role === "architect") tools.push("muster_submit_scope");
  if (evidenceEnabled && role === "validator") tools.push("muster_submit_gate");
  if (writeEnabled && role !== "reviewer" && role !== "validator") {
    tools.push("muster_write", "muster_command");
  }
  return tools;
}

export function brokeredChildRuntime(
  role: BrokerChildRole,
  writeEnabled = role === "builder",
  evidenceEnabled = false,
): ResolvedChildRuntime {
  return {
    extensions: [CHILD_BROKER_EXTENSION],
    tools: brokeredToolNames(role, writeEnabled, evidenceEnabled),
  };
}

function accessForRole(role: BrokerChildRole, writeEnabled = role === "builder"): ChildAccess {
  if (role === "reviewer") return "read";
  if (role === "validator") return "validator";
  return writeEnabled ? "write" : "read";
}

export function standardChildRuntime(options: Pick<RunBrokeredChildOptions, "role" | "evidenceEnabled" | "writeEnabled" | "run" | "modelStack">): ResolvedChildRuntime {
  const runtime = resolveChildRuntime(
    options.modelStack ?? {}, options.run.slot ?? {}, accessForRole(options.role, options.writeEnabled),
  );
  const evidenceTools = !options.evidenceEnabled ? []
    : options.role === "architect" ? ["muster_submit_scope"]
    : options.role === "validator" ? ["muster_submit_gate"] : [];
  return {
    extensions: [...new Set([...runtime.extensions, ...(evidenceTools.length ? [CHILD_BROKER_EXTENSION] : [])])],
    tools: [...new Set([...runtime.tools, ...evidenceTools])],
  };
}

function send(socket: Socket, message: BrokerMessage): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

export async function startChildBrokerServer(
  options: ChildBrokerServerOptions,
): Promise<ChildBrokerServer> {
  const host = options.host ?? "127.0.0.1";
  const identity: BrokerPeerIdentity = {
    authToken: options.authToken ?? createBrokerAuthToken(),
    runId: options.runId,
    childId: options.childId,
    taskId: options.taskId,
  };
  const sockets = new Set<Socket>();
  const controllers = new Map<string, AbortController>();
  let requestCount = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let negotiatedVersion: number | null = null;
    const processLine = async (line: string) => {
      let message: BrokerMessage;
      try {
        message = parseBrokerMessage(line, { expected: identity });
      } catch {
        socket.destroy();
        return;
      }
      if (message.type === "broker.hello") {
        try {
          negotiatedVersion = negotiateBrokerProtocol(
            [BROKER_PROTOCOL_VERSION],
            message.supportedVersions,
          );
          send(socket, {
            ...identity,
            type: "broker.ready",
            protocolVersion: negotiatedVersion,
          });
        } catch {
          socket.destroy();
        }
        return;
      }
      if (negotiatedVersion === null || message.type === "broker.ready") {
        socket.destroy();
        return;
      }
      if (message.type === "broker.cancel") {
        controllers.get(message.requestCorrelationId)?.abort();
        return;
      }
      if (message.type !== "broker.request" || message.protocolVersion !== negotiatedVersion) {
        socket.destroy();
        return;
      }
      const controller = new AbortController();
      controllers.set(message.correlationId, controller);
      try {
        requestCount += 1;
        if (options.maxRequests !== undefined && requestCount > options.maxRequests) {
          throw new Error(`Broker request limit exceeded (${options.maxRequests})`);
        }
        const output = await options.handleRequest({
          correlationId: message.correlationId,
          tool: message.tool,
          input: message.input,
          signal: controller.signal,
        });
        const response: BrokerMessage = {
          ...identity,
          type: "broker.response",
          protocolVersion: negotiatedVersion,
          correlationId: message.correlationId,
          ok: true,
          output,
        };
        parseBrokerMessage(response, { expected: identity });
        if (!socket.destroyed) send(socket, response);
      } catch (error) {
        const response: BrokerMessage = {
          ...identity,
          type: "broker.response",
          protocolVersion: negotiatedVersion,
          correlationId: message.correlationId,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 8_192) : String(error).slice(0, 8_192),
        };
        if (!socket.destroyed) send(socket, response);
      } finally {
        controllers.delete(message.correlationId);
      }
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) void processLine(line);
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new BrokerProtocolError("BROKER_MESSAGE_INVALID", "Broker server did not receive a TCP address");
  }
  return {
    identity,
    port: address.port,
    environment: {
      MUSTER_BROKER_HOST: host,
      MUSTER_BROKER_PORT: String(address.port),
      MUSTER_BROKER_TOKEN: identity.authToken,
      MUSTER_BROKER_RUN_ID: identity.runId,
      MUSTER_BROKER_CHILD_ID: identity.childId,
      MUSTER_BROKER_TASK_ID: identity.taskId,
    },
    async close() {
      for (const controller of controllers.values()) controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

export async function runBrokeredChild(options: RunBrokeredChildOptions): Promise<AgentRun> {
  const toolMode = options.toolMode ?? "standard";
  const writeEnabled = options.writeEnabled ?? options.role === "builder";
  const childRuntime = toolMode === "brokered"
    ? brokeredChildRuntime(options.role, writeEnabled, options.evidenceEnabled)
    : standardChildRuntime(options);
  const broker = toolMode === "brokered" || options.evidenceEnabled
    ? await startChildBrokerServer(options) : undefined;
  try {
    return await runChild({
      run: options.run,
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      appendSystemPrompts: options.appendSystemPrompts,
      access: accessForRole(options.role, options.writeEnabled),
      childRuntime,
      thinking: options.thinking,
      sessionDir: options.sessionDir,
      sessionId: options.sessionId,
      fork: options.fork,
      resume: options.resume,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      environment: {
        ...broker?.environment,
        MUSTER_TOOL_MODE: toolMode,
        MUSTER_BROKER_ROLE: options.role,
        MUSTER_BROKER_WRITE_ENABLED: writeEnabled ? "1" : "0",
      },
    });
  } finally {
    await broker?.close();
  }
}
