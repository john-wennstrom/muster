import { randomUUID } from "node:crypto";
import {
  BROKER_PROTOCOL_VERSION,
  BrokerProtocolError,
  parseBrokerMessage,
  type BrokerMessage,
  type BrokerPeerIdentity,
  type BrokerResponse,
  type ParseBrokerMessageOptions,
} from "../tools/protocol.ts";

export interface BrokerTransport {
  send(message: BrokerMessage): Promise<void> | void;
}

export interface BrokerClientOptions extends BrokerPeerIdentity {
  transport: BrokerTransport;
  supportedVersions?: readonly number[];
  maxMessageBytes?: number;
  maxOutputBytes?: number;
}

interface PendingRequest {
  resolve(output: unknown): void;
  reject(error: Error): void;
  removeAbortListener(): void;
}

function abortError(): Error {
  const error = new Error("Broker request was cancelled");
  error.name = "AbortError";
  return error;
}

export class BrokerClient {
  private readonly identity: BrokerPeerIdentity;
  private readonly parseOptions: ParseBrokerMessageOptions;
  private readonly supportedVersions: readonly number[];
  private readonly pending = new Map<string, PendingRequest>();
  private protocolVersion: number | null = null;

  constructor(private readonly options: BrokerClientOptions) {
    this.identity = {
      authToken: options.authToken,
      runId: options.runId,
      childId: options.childId,
      taskId: options.taskId,
    };
    this.supportedVersions = options.supportedVersions ?? [BROKER_PROTOCOL_VERSION];
    this.parseOptions = {
      expected: this.identity,
      maxMessageBytes: options.maxMessageBytes,
      maxOutputBytes: options.maxOutputBytes,
    };
  }

  async start(): Promise<void> {
    await this.options.transport.send({
      ...this.identity,
      type: "broker.hello",
      supportedVersions: [...this.supportedVersions],
    });
  }

  acceptReady(value: string | unknown): number {
    const message = parseBrokerMessage(value, this.parseOptions);
    if (message.type !== "broker.ready" || !this.supportedVersions.includes(message.protocolVersion)) {
      throw new BrokerProtocolError(
        "BROKER_VERSION_UNSUPPORTED",
        "Broker parent selected an unsupported protocol version",
      );
    }
    this.protocolVersion = message.protocolVersion;
    return message.protocolVersion;
  }

  async request(tool: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.protocolVersion === null) {
      throw new BrokerProtocolError("BROKER_VERSION_UNSUPPORTED", "Broker handshake is not complete");
    }
    if (signal?.aborted) throw abortError();
    const correlationId = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        void this.options.transport.send({
          ...this.identity,
          type: "broker.cancel",
          protocolVersion: this.protocolVersion!,
          correlationId: randomUUID(),
          requestCorrelationId: correlationId,
        });
        this.pending.delete(correlationId);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(correlationId, {
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
      });
    });
    await this.options.transport.send({
      ...this.identity,
      type: "broker.request",
      protocolVersion: this.protocolVersion,
      correlationId,
      tool,
      input,
    });
    return response;
  }

  receive(value: string | unknown): void {
    const message = parseBrokerMessage(value, this.parseOptions);
    if (message.type !== "broker.response" || message.protocolVersion !== this.protocolVersion) {
      throw new BrokerProtocolError("BROKER_MESSAGE_INVALID", "Broker client received an unexpected message");
    }
    this.settle(message);
  }

  close(reason = "Broker client closed"): void {
    for (const request of this.pending.values()) {
      request.removeAbortListener();
      request.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private settle(message: BrokerResponse): void {
    const request = this.pending.get(message.correlationId);
    if (!request) {
      throw new BrokerProtocolError(
        "BROKER_MESSAGE_INVALID",
        "Broker response has no pending correlation",
        { correlationId: message.correlationId },
      );
    }
    this.pending.delete(message.correlationId);
    request.removeAbortListener();
    if (message.ok) request.resolve(message.output);
    else request.reject(new Error(message.error));
  }
}