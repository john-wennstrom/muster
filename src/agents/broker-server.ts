import { createServer, type Socket } from "node:net";
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
