import { afterEach } from "bun:test";
import {
  JUDGMENT_MODEL,
  type JudgmentAnswers,
  type JudgmentClient,
  type JudgmentClientRequest,
  type JudgmentUnavailableReason,
} from "../../src/judgment/client.ts";

/** A request the script does not cover: a test that reaches the service without saying what answers. */
export class ScriptedJudgmentError extends Error {
  readonly decision: string;

  constructor(decision: string) {
    super(`The judgment script has no answers for decision ${decision}`);
    this.name = "ScriptedJudgmentError";
    this.decision = decision;
  }
}

type Answer = JudgmentAnswers | ((request: JudgmentClientRequest) => JudgmentAnswers);

export interface ScriptedClient extends JudgmentClient {
  /** Every request served, in order. */
  readonly requests: readonly JudgmentClientRequest[];
  /** Decisions asked about that the script did not cover. Any entry fails the test that made it. */
  readonly uncovered: readonly string[];
}

const created: ScriptedClient[] = [];

// A client swallowed into "unavailable" by the layer under test would let a test pass while
// checking nothing, so an uncovered request also fails the test when it ends.
afterEach(() => {
  const uncovered = created.splice(0).flatMap((client) => client.uncovered);
  if (uncovered.length > 0) throw new ScriptedJudgmentError([...new Set(uncovered)].join(", "));
});

/**
 * Answers each decision from `script`: a fixed set of answers, or a function of the request that
 * returns answers keyed by question identifier. A decision the script does not name throws
 * `ScriptedJudgmentError` and is remembered, so the test fails even if the caller swallows it.
 */
export function createScriptedClient(
  script: Readonly<Record<string, Answer>>,
  options: { readonly inputTokens?: number } = {},
): ScriptedClient {
  const requests: JudgmentClientRequest[] = [];
  const uncovered: string[] = [];
  const client: ScriptedClient = {
    requests,
    uncovered,
    async request(request) {
      const decision = request.decision?.id ?? "unnamed";
      const answer = script[decision];
      if (answer === undefined) {
        uncovered.push(decision);
        throw new ScriptedJudgmentError(decision);
      }
      requests.push(request);
      return {
        available: true,
        answers: typeof answer === "function" ? answer(request) : answer,
        model: JUDGMENT_MODEL,
        inputTokens: options.inputTokens ?? 1_000,
        outputTokens: 0,
        durationMs: 0,
      };
    },
  };
  created.push(client);
  return client;
}

/** A client that is always unavailable for `reason`, to simulate each way the service can fail. */
export function createDeadClient(reason: JudgmentUnavailableReason = "network"): JudgmentClient {
  return {
    async request() {
      return { available: false, reason, durationMs: 0 };
    },
  };
}
