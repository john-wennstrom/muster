import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const BROKER_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_BROKER_MESSAGE_BYTES = 1_048_576;
export const DEFAULT_MAX_BROKER_OUTPUT_BYTES = 262_144;

const identifier = z.string().min(1).max(256);
const authToken = z.string().min(32).max(512);
const envelope = {
  authToken,
  runId: identifier,
  childId: identifier,
  taskId: identifier,
};

export const brokerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("broker.hello"),
    supportedVersions: z.array(z.number().int().positive()).min(1),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("broker.ready"),
    protocolVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("broker.request"),
    protocolVersion: z.number().int().positive(),
    correlationId: z.uuid(),
    tool: identifier,
    input: z.unknown(),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("broker.cancel"),
    protocolVersion: z.number().int().positive(),
    correlationId: z.uuid(),
    requestCorrelationId: z.uuid(),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("broker.response"),
    protocolVersion: z.number().int().positive(),
    correlationId: z.uuid(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().min(1).max(8_192).optional(),
  }).strict().refine(
    (message) => message.ok ? message.error === undefined : message.error !== undefined,
    { message: "Broker response success and error fields are inconsistent" },
  ),
]);

export type BrokerMessage = z.infer<typeof brokerMessageSchema>;
export type BrokerResponse = Extract<BrokerMessage, { type: "broker.response" }>;

export const brokerAuditEventSchema = z.object({
  schemaVersion: z.literal(1),
  timestamp: z.iso.datetime(),
  runId: identifier,
  childId: identifier,
  taskId: identifier,
  correlationId: z.uuid(),
  tool: identifier.optional(),
  decision: z.enum(["allow", "deny", "cancel", "complete", "error"]),
  reason: z.string().min(1).max(8_192).optional(),
  requestBytes: z.number().int().nonnegative(),
  responseBytes: z.number().int().nonnegative().optional(),
}).strict();

export type BrokerAuditEvent = z.infer<typeof brokerAuditEventSchema>;

export interface BrokerPeerIdentity {
  authToken: string;
  runId: string;
  childId: string;
  taskId: string;
}

export interface ParseBrokerMessageOptions {
  expected: BrokerPeerIdentity;
  maxMessageBytes?: number;
  maxOutputBytes?: number;
}

export class BrokerProtocolError extends Error {
  constructor(
    readonly code:
      | "BROKER_AUTH_FAILED"
      | "BROKER_IDENTITY_MISMATCH"
      | "BROKER_MESSAGE_INVALID"
      | "BROKER_MESSAGE_TOO_LARGE"
      | "BROKER_OUTPUT_TOO_LARGE"
      | "BROKER_VERSION_UNSUPPORTED",
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "BrokerProtocolError";
  }
}

function encoded(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    throw new BrokerProtocolError("BROKER_MESSAGE_INVALID", "Broker message is not JSON serializable");
  }
}

function authenticated(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createBrokerAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

export function parseBrokerMessage(
  value: string | unknown,
  options: ParseBrokerMessageOptions,
): BrokerMessage {
  const serialized = encoded(value);
  const messageBytes = Buffer.byteLength(serialized);
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_BROKER_MESSAGE_BYTES;
  if (messageBytes > maxMessageBytes) {
    throw new BrokerProtocolError(
      "BROKER_MESSAGE_TOO_LARGE",
      `Broker message exceeds ${maxMessageBytes} bytes`,
      { messageBytes, maxMessageBytes },
    );
  }
  let decoded: unknown = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new BrokerProtocolError("BROKER_MESSAGE_INVALID", "Broker message is not valid JSON");
    }
  }
  const result = brokerMessageSchema.safeParse(decoded);
  if (!result.success) {
    throw new BrokerProtocolError(
      "BROKER_MESSAGE_INVALID",
      "Broker message does not match the protocol schema",
      { issues: result.error.issues },
    );
  }
  const message = result.data;
  if (!authenticated(message.authToken, options.expected.authToken)) {
    throw new BrokerProtocolError("BROKER_AUTH_FAILED", "Broker message authentication failed");
  }
  for (const field of ["runId", "childId", "taskId"] as const) {
    if (message[field] !== options.expected[field]) {
      throw new BrokerProtocolError(
        "BROKER_IDENTITY_MISMATCH",
        `Broker message ${field} does not match the authenticated peer`,
        { field, actual: message[field], expected: options.expected[field] },
      );
    }
  }
  if (message.type === "broker.response" && message.output !== undefined) {
    const outputBytes = Buffer.byteLength(encoded(message.output));
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_BROKER_OUTPUT_BYTES;
    if (outputBytes > maxOutputBytes) {
      throw new BrokerProtocolError(
        "BROKER_OUTPUT_TOO_LARGE",
        `Broker response output exceeds ${maxOutputBytes} bytes`,
        { outputBytes, maxOutputBytes, correlationId: message.correlationId },
      );
    }
  }
  return message;
}

export function negotiateBrokerProtocol(
  localVersions: readonly number[],
  remoteVersions: readonly number[],
): number {
  const remote = new Set(remoteVersions);
  const selected = [...new Set(localVersions)]
    .filter((version) => Number.isInteger(version) && version > 0 && remote.has(version))
    .sort((left, right) => right - left)[0];
  if (selected === undefined) {
    throw new BrokerProtocolError(
      "BROKER_VERSION_UNSUPPORTED",
      "Broker peers have no mutually supported protocol version",
      { localVersions, remoteVersions },
    );
  }
  return selected;
}