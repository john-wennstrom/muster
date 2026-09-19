import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  JudgmentClient,
  JudgmentClientRequest,
  JudgmentClientResult,
  JudgmentUnavailableReason,
} from "./client.ts";
import { canonicalize } from "./questions.ts";

/**
 * Recorded fixtures so automated tests never reach the network. A fixture is keyed by the
 * decision, its version, and hashes of the canonical state and questions, so changed wording,
 * a changed state, or a version bump is a different recording. Fixtures hold the state as it
 * was sent (already redacted) and never the API key, which no client ever passes here.
 */

export const JUDGMENT_FIXTURES_DIRECTORY = fileURLToPath(
  new URL("../../tests/fixtures/judgment", import.meta.url),
);

/**
 * Thrown when no recording matches. It is deliberately not an unavailable result: if a miss
 * looked like a dead client the fallback would run and the test would pass testing nothing.
 */
export class JudgmentFixtureMissingError extends Error {
  readonly decision: string;
  readonly key: string;

  constructor(decision: string, key: string, directory: string) {
    super(
      `No judgment fixture for decision ${decision} (${key}) in ${directory}. ` +
        "Record one against the live service; tests never reach the network.",
    );
    this.name = "JudgmentFixtureMissingError";
    this.decision = decision;
    this.key = key;
  }
}

type AvailableResult = Extract<JudgmentClientResult, { available: true }>;

interface FixtureFile {
  schemaVersion: 1;
  decision: string;
  version: number;
  state: JudgmentClientRequest["state"];
  questions: JudgmentClientRequest["questions"];
  response: Omit<AvailableResult, "durationMs">;
}

const UNNAMED_DECISION = { id: "unnamed", version: 0 } as const;

function shortHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex").slice(0, 16);
}

export function fixtureKey(
  request: Pick<JudgmentClientRequest, "state" | "questions" | "decision">,
): string {
  const decision = request.decision ?? UNNAMED_DECISION;
  const name = decision.id.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${name}@v${decision.version}.${shortHash(request.state)}.${shortHash(request.questions)}`;
}

function fixturePath(directory: string, request: JudgmentClientRequest): string {
  return join(directory, `${fixtureKey(request)}.json`);
}

/** Serves recordings only. A request with no recording throws instead of going anywhere. */
export function createReplayClient(
  directory: string = JUDGMENT_FIXTURES_DIRECTORY,
): JudgmentClient {
  return {
    async request(request) {
      let fixture: FixtureFile;
      try {
        fixture = JSON.parse(await readFile(fixturePath(directory, request), "utf8")) as FixtureFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new JudgmentFixtureMissingError(
            (request.decision ?? UNNAMED_DECISION).id,
            fixtureKey(request),
            directory,
          );
        }
        throw error;
      }
      return { ...fixture.response, durationMs: 0 };
    },
  };
}

/**
 * Wraps a live client and writes each answered response as a fixture, so a developer can
 * capture recordings without changing the code under test. CI never uses this.
 */
export function createRecordingClient(
  live: JudgmentClient,
  directory: string = JUDGMENT_FIXTURES_DIRECTORY,
): JudgmentClient {
  return {
    async request(request) {
      const result = await live.request(request);
      if (!result.available) return result;
      const decision = request.decision ?? UNNAMED_DECISION;
      const { durationMs: _durationMs, ...response } = result;
      const fixture: FixtureFile = {
        schemaVersion: 1,
        decision: decision.id,
        version: decision.version,
        state: request.state,
        questions: request.questions,
        response,
      };
      await mkdir(directory, { recursive: true });
      await writeFile(fixturePath(directory, request), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
      return result;
    },
  };
}

/** A client that is always unavailable for a chosen reason, for fallback tests. */
export function createDeadClient(
  reason: JudgmentUnavailableReason = "network",
): JudgmentClient {
  return {
    async request() {
      return { available: false, reason, durationMs: 0 };
    },
  };
}
