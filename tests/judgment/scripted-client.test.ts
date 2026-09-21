import { describe, expect, test } from "bun:test";
import type { JudgmentUnavailableReason } from "../../src/judgment/client.ts";
import { createDeadClient, createScriptedClient, ScriptedJudgmentError } from "../helpers/scripted-judgment.ts";

const questions = { q: { type: "noul", instructions: "Is it?" } } as const;
const answer = { q: { type: "noul", noul: 1 } } as const;

describe("scripted judgment client", () => {
  test("serves the scripted answers for a decision", async () => {
    const client = createScriptedClient({ "a.decision": answer });
    const result = await client.request({ state: {}, questions, decision: { id: "a.decision", version: 1 } });
    expect(result).toMatchObject({ available: true, answers: answer });
    expect(client.requests).toHaveLength(1);
  });

  test("answers from a function of the request", async () => {
    const client = createScriptedClient({
      "a.decision": (request) => ({ q: { type: "noul", noul: request.state === "yes" ? 1 : 0 } }),
    });
    const result = await client.request({ state: "yes", questions, decision: { id: "a.decision", version: 1 } });
    expect(result.available && result.answers.q).toEqual({ type: "noul", noul: 1 });
  });

  test("an uncovered request throws an error naming the decision", async () => {
    const client = createScriptedClient({});
    await expect(client.request({ state: {}, questions, decision: { id: "other.decision", version: 1 } }))
      .rejects.toBeInstanceOf(ScriptedJudgmentError);
    expect(client.uncovered).toEqual(["other.decision"]);
    (client.uncovered as string[]).splice(0); // this test made the uncovered request on purpose
  });

  const reasons: JudgmentUnavailableReason[] = [
    "timeout", "rate_limit", "network", "server", "invalid_response", "model_mismatch", "aborted",
  ];
  test.each(reasons)("the dead client simulates %s", async (reason) => {
    const result = await createDeadClient(reason).request({ state: {}, questions });
    expect(result).toEqual({ available: false, reason, durationMs: 0 });
  });
});
