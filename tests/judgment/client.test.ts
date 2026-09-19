import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  JUDGMENT_MODEL,
  createFetchJudgmentClient,
  type JudgmentQuestions,
} from "../../src/judgment/client.ts";

const questions: JudgmentQuestions = {
  public_contract: { type: "noul", instructions: "Does the request change a public contract?" },
  disposition: {
    type: "choice",
    instructions: "What should happen with this request?",
    criteria: { proceed: "Plan it.", already_done: null, needs_clarification: null },
  },
  materiality: {
    type: "score",
    instructions: "How material is the change?",
    criteria: ["Cosmetic", "Minor", "Material"],
  },
};

const sample = JSON.parse(
  await readFile(resolve(import.meta.dir, "../fixtures/judgment/sample-response.json"), "utf8"),
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch, extra: { backoffBaseMs?: number } = {}) {
  return createFetchJudgmentClient({
    apiKey: "test-key-123",
    fetch: fetchImpl,
    backoffBaseMs: 1,
    random: () => 0.5,
    ...extra,
  });
}

/** A fetch that never answers on its own and only settles when its signal aborts. */
const hangingFetch: typeof fetch = ((_url: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;

describe("judgment client", () => {
  test("returns typed answers and usage for a recorded sample response", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const result = await client((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return json(sample);
    }) as unknown as typeof fetch).request({ state: { request: "x" }, questions });

    expect(result).toMatchObject({
      available: true,
      model: JUDGMENT_MODEL,
      inputTokens: 1_234,
      outputTokens: 0,
    });
    if (!result.available) throw new Error("expected answers");
    expect(result.answers.public_contract).toEqual({ type: "noul", noul: 0.91 });
    expect(result.answers.disposition).toMatchObject({ type: "choice", choice: "proceed" });
    expect(result.answers.materiality).toMatchObject({ type: "score", score: 1.4 });

    const body = JSON.parse(String(seen!.init.body));
    expect(body.model).toBe("jev-1.13.0");
    expect(body.model).not.toContain("latest");
    expect(body.state).toEqual({ request: "x" });
    expect(Object.keys(body.questions)).toEqual(Object.keys(questions));
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer test-key-123");
  });

  test("recovers when a retry succeeds after a rate limit", async () => {
    let calls = 0;
    const result = await client((async () => {
      calls += 1;
      return calls === 1 ? new Response("slow down", { status: 429 }) : json(sample);
    }) as unknown as typeof fetch).request({ state: "s", questions });

    expect(result.available).toBe(true);
    expect(calls).toBe(2);
  });

  test("reports a rate limit after two retries are spent", async () => {
    let calls = 0;
    const result = await client((async () => {
      calls += 1;
      return new Response("", { status: 529 });
    }) as unknown as typeof fetch).request({ state: "s", questions });

    expect(result).toMatchObject({ available: false, reason: "rate_limit" });
    expect(calls).toBe(3);
  });

  test("does not retry a server failure", async () => {
    let calls = 0;
    const result = await client((async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch).request({ state: "s", questions });

    expect(result).toMatchObject({ available: false, reason: "server" });
    expect(calls).toBe(1);
  });

  test("reports an unreachable service as a network failure", async () => {
    const result = await client((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch).request({ state: "s", questions });

    expect(result).toMatchObject({ available: false, reason: "network" });
  });

  test("times out no later than the deadline", async () => {
    const started = Date.now();
    const result = await client(hangingFetch).request({ state: "s", questions, deadlineMs: 40 });

    expect(result).toMatchObject({ available: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("covers backoff inside the deadline", async () => {
    const result = await client(
      (async () => new Response("", { status: 429 })) as unknown as typeof fetch,
      { backoffBaseMs: 10_000 },
    ).request({ state: "s", questions, deadlineMs: 40 });

    expect(result).toMatchObject({ available: false, reason: "timeout" });
  });

  test("ends promptly when the caller cancels", async () => {
    const controller = new AbortController();
    const pending = client(hangingFetch).request({
      state: "s",
      questions,
      signal: controller.signal,
      deadlineMs: 5_000,
    });
    setTimeout(() => controller.abort(), 10);

    expect(await pending).toMatchObject({ available: false, reason: "aborted" });
  });

  test("does not send when already cancelled", async () => {
    let calls = 0;
    const result = await client((async () => {
      calls += 1;
      return json(sample);
    }) as unknown as typeof fetch).request({ state: "s", questions, signal: AbortSignal.abort() });

    expect(result).toMatchObject({ available: false, reason: "aborted" });
    expect(calls).toBe(0);
  });

  test("rejects malformed, partial, and out-of-range responses without partial answers", async () => {
    const withAnswers = (mutate: (copy: any) => void) => {
      const copy = structuredClone(sample);
      mutate(copy);
      return copy;
    };
    const cases: Record<string, unknown> = {
      "not an object": "nope",
      "missing usage": withAnswers((c) => delete c.usage),
      "omitted question": withAnswers((c) => delete c.answers.materiality),
      "choice outside options": withAnswers((c) => { c.answers.disposition.choice = "elsewhere"; }),
      "probability outside options": withAnswers((c) => { c.answers.disposition.probabilities.elsewhere = 0.1; }),
      "score outside rubric": withAnswers((c) => { c.answers.materiality.score = 3.2; }),
      "noul outside unit interval": withAnswers((c) => { c.answers.public_contract.noul = 1.5; }),
      "wrong answer type": withAnswers((c) => { c.answers.public_contract = { type: "score", score: 1, probabilities: {}, confidence: 1 }; }),
    };

    for (const [name, payload] of Object.entries(cases)) {
      const result = await client((async () => json(payload)) as unknown as typeof fetch)
        .request({ state: "s", questions });
      expect({ name, ...result }).toMatchObject({ name, available: false, reason: "invalid_response" });
      expect(result).not.toHaveProperty("answers");
    }
  });

  test("treats a body that is not JSON as an invalid response", async () => {
    const result = await client((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)
      .request({ state: "s", questions });

    expect(result).toMatchObject({ available: false, reason: "invalid_response" });
  });

  test("treats a different reported model as unavailable and reports it", async () => {
    const result = await client((async () => json({ ...sample, model: "jev-1.14.0" })) as unknown as typeof fetch)
      .request({ state: "s", questions });

    expect(result).toMatchObject({
      available: false,
      reason: "model_mismatch",
      reportedModel: "jev-1.14.0",
    });
  });

  test("returns only the requested answers", async () => {
    const payload = structuredClone(sample);
    payload.answers.extra = { type: "noul", noul: 0.5 };
    const result = await client((async () => json(payload)) as unknown as typeof fetch)
      .request({ state: "s", questions });

    if (!result.available) throw new Error("expected answers");
    expect(Object.keys(result.answers).sort()).toEqual(Object.keys(questions).sort());
  });
});
