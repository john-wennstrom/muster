import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JudgmentClient,
  JudgmentQuestions,
  JudgmentUnavailableReason,
} from "../../src/judgment/client.ts";
import {
  JUDGMENT_FIXTURES_DIRECTORY,
  JudgmentFixtureMissingError,
  createDeadClient,
  createRecordingClient,
  createReplayClient,
  fixtureKey,
} from "../../src/judgment/replay.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureDirectory() {
  const path = await mkdtemp(join(tmpdir(), "judgment-fixtures-"));
  directories.push(path);
  return path;
}

const questions: JudgmentQuestions = {
  public_contract: { type: "noul", instructions: "Does the request change a public contract?" },
};

const request = {
  decision: { id: "test.sample", version: 1 },
  state: { request: "Change the wire format" },
  questions,
};

function liveClient(): { client: JudgmentClient; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      async request() {
        calls += 1;
        return {
          available: true,
          answers: { public_contract: { type: "noul", noul: 0.93 } },
          model: "jev-1.13.0",
          inputTokens: 321,
          outputTokens: 0,
          durationMs: 87,
        };
      },
    },
  };
}

describe("recorded fixtures", () => {
  test("replays a matching recording without a live client", async () => {
    const directory = await fixtureDirectory();
    const live = liveClient();
    const recorded = await createRecordingClient(live.client, directory).request(request);
    expect(live.calls()).toBe(1);

    const replayed = await createReplayClient(directory).request(request);
    expect(replayed).toMatchObject({
      available: true,
      model: "jev-1.13.0",
      inputTokens: 321,
      outputTokens: 0,
      answers: { public_contract: { type: "noul", noul: 0.93 } },
    });
    expect(recorded).toMatchObject({ available: true });
    expect(live.calls()).toBe(1);
  });

  test("keys ignore object key order", () => {
    expect(fixtureKey({ ...request, state: { a: 1, b: 2 } }))
      .toBe(fixtureKey({ ...request, state: { b: 2, a: 1 } }));
  });

  test.each([
    ["state", { ...request, state: { request: "Something else" } }],
    ["questions", {
      ...request,
      questions: { public_contract: { type: "noul", instructions: "A reworded question?" } } as JudgmentQuestions,
    }],
    ["version", { ...request, decision: { id: "test.sample", version: 2 } }],
    ["decision", { ...request, decision: { id: "test.other", version: 1 } }],
  ])("differing %s is a different recording", async (_name, changed) => {
    const directory = await fixtureDirectory();
    await createRecordingClient(liveClient().client, directory).request(request);

    expect(fixtureKey(changed)).not.toBe(fixtureKey(request));
    await expect(createReplayClient(directory).request(changed))
      .rejects.toBeInstanceOf(JudgmentFixtureMissingError);
  });

  test("a miss throws naming the decision instead of yielding an unavailable result", async () => {
    const directory = await fixtureDirectory();
    const pending = createReplayClient(directory).request(request);

    await expect(pending).rejects.toBeInstanceOf(JudgmentFixtureMissingError);
    await expect(pending).rejects.toMatchObject({ decision: "test.sample" });
    await expect(pending).rejects.toThrow(/test\.sample/);
  });

  test("records the state as sent and never the credential", async () => {
    const directory = await fixtureDirectory();
    await createRecordingClient(liveClient().client, directory).request({
      ...request,
      state: { log: "Authorization: Bearer [REDACTED]" },
    });

    const [file] = await readdir(directory);
    const text = await readFile(join(directory, file!), "utf8");
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      decision: "test.sample",
      version: 1,
      state: { log: "Authorization: Bearer [REDACTED]" },
    });
    expect(text).not.toContain("api");
  });

  test("does not record an unavailable result", async () => {
    const directory = await fixtureDirectory();
    const result = await createRecordingClient(createDeadClient("timeout"), directory).request(request);

    expect(result).toMatchObject({ available: false, reason: "timeout" });
    expect(await readdir(directory)).toEqual([]);
  });

  test("the fixtures directory is the repository's test fixtures", () => {
    expect(JUDGMENT_FIXTURES_DIRECTORY.endsWith(join("tests", "fixtures", "judgment"))).toBe(true);
  });
});

describe("dead client", () => {
  const reasons: JudgmentUnavailableReason[] = [
    "disabled", "not_configured", "invalid_configuration", "budget", "state_denied",
    "state_too_large", "timeout", "rate_limit", "network", "server", "invalid_response",
    "model_mismatch", "aborted",
  ];

  test.each(reasons)("yields %s", async (reason) => {
    expect(await createDeadClient(reason).request(request))
      .toEqual({ available: false, reason, durationMs: 0 });
  });

  test("defaults to a network failure", async () => {
    expect(await createDeadClient().request(request)).toMatchObject({ reason: "network" });
  });
});
