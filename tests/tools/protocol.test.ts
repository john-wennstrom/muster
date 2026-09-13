import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BrokerClient } from "../../src/agents/broker-client.ts";
import {
  BROKER_PROTOCOL_VERSION,
  brokerAuditEventSchema,
  createBrokerAuthToken,
  negotiateBrokerProtocol,
  parseBrokerMessage,
  type BrokerMessage,
} from "../../src/tools/protocol.ts";

const identity = {
  authToken: createBrokerAuthToken(),
  runId: "run-1",
  childId: "child-1",
  taskId: "7.1",
};

describe("tool broker protocol", () => {
  test("rejects spoofed identities and malformed requests", () => {
    const request = {
      ...identity,
      type: "broker.request" as const,
      protocolVersion: BROKER_PROTOCOL_VERSION,
      correlationId: randomUUID(),
      tool: "read_file",
      input: { path: "README.md" },
    };

    expect(() => parseBrokerMessage({ ...request, authToken: createBrokerAuthToken() }, {
      expected: identity,
    })).toThrow(/authentication failed/);
    expect(() => parseBrokerMessage({ ...request, taskId: "other-task" }, {
      expected: identity,
    })).toThrow(/taskId does not match/);
    expect(() => parseBrokerMessage({ ...request, correlationId: "not-a-uuid" }, {
      expected: identity,
    })).toThrow(/protocol schema/);
  });

  test("negotiates only a mutually supported protocol version", () => {
    expect(negotiateBrokerProtocol([1, 2], [1, 3])).toBe(1);
    expect(() => negotiateBrokerProtocol([1], [2])).toThrow(/no mutually supported/);
  });

  test("rejects oversized messages and response output", () => {
    expect(() => parseBrokerMessage(JSON.stringify({
      ...identity,
      type: "broker.hello",
      supportedVersions: [1],
      padding: "x".repeat(100),
    }), {
      expected: identity,
      maxMessageBytes: 32,
    })).toThrow(/exceeds 32 bytes/);

    expect(() => parseBrokerMessage({
      ...identity,
      type: "broker.response",
      protocolVersion: 1,
      correlationId: randomUUID(),
      ok: true,
      output: "x".repeat(100),
    }, {
      expected: identity,
      maxOutputBytes: 32,
    })).toThrow(/output exceeds 32 bytes/);
  });

  test("correlates responses and emits cancellation", async () => {
    const sent: BrokerMessage[] = [];
    const client = new BrokerClient({
      ...identity,
      transport: { send: (message) => { sent.push(message); } },
    });
    await client.start();
    client.acceptReady({
      ...identity,
      type: "broker.ready",
      protocolVersion: 1,
    });

    const controller = new AbortController();
    const pending = client.request("read_file", { path: "README.md" }, controller.signal);
    await Promise.resolve();
    const request = sent.find((message) => message.type === "broker.request");
    expect(request?.type).toBe("broker.request");
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const cancel = sent.find((message) => message.type === "broker.cancel");
    expect(cancel?.type === "broker.cancel" && request?.type === "broker.request"
      ? cancel.requestCorrelationId
      : null).toBe(request?.type === "broker.request" ? request.correlationId : null);
  });

  test("resolves only the matching authenticated response", async () => {
    const sent: BrokerMessage[] = [];
    const client = new BrokerClient({
      ...identity,
      transport: { send: (message) => { sent.push(message); } },
    });
    client.acceptReady({
      ...identity,
      type: "broker.ready",
      protocolVersion: 1,
    });
    const pending = client.request("read_file", { path: "README.md" });
    await Promise.resolve();
    const request = sent.find((message) => message.type === "broker.request");
    if (request?.type !== "broker.request") throw new Error("request was not sent");

    client.receive({
      ...identity,
      type: "broker.response",
      protocolVersion: 1,
      correlationId: request.correlationId,
      ok: true,
      output: { contents: "muster" },
    });

    await expect(pending).resolves.toEqual({ contents: "muster" });
  });

  test("validates bounded audit events without authentication material", () => {
    const event = brokerAuditEventSchema.parse({
      schemaVersion: 1,
      timestamp: "2026-09-12T12:00:00.000Z",
      runId: identity.runId,
      childId: identity.childId,
      taskId: identity.taskId,
      correlationId: randomUUID(),
      tool: "write_file",
      decision: "deny",
      reason: "reviewer role is read-only",
      requestBytes: 120,
    });

    expect(event).not.toHaveProperty("authToken");
  });
});