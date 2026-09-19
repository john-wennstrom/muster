import { z } from "zod";

/**
 * Transport to the judgment service (`POST /v1/systemone`, https://docs.typesafe.ai/api).
 * A request carries one state and a map of typed questions; the response carries one typed
 * answer per question, the model that answered, and token usage. Nothing here throws for an
 * operational failure: every outcome is either answers or an unavailable result.
 */

/** Pinned model version. A moving alias would silently invalidate tuned thresholds. */
export const JUDGMENT_MODEL = "jev-1.13.0";
export const JUDGMENT_PROVIDER = "typesafe";
/** $42 per billion input tokens; output tokens are not charged. */
export const JUDGMENT_COST_PER_INPUT_TOKEN_USD = 0.042 / 1_000_000;
export const JUDGMENT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JUDGMENT_DEFAULT_DEADLINE_MS = 5_000;
export const JUDGMENT_MAX_RETRIES = 2;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JudgmentQuestion =
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria?: { readonly true?: string; readonly false?: string };
    }
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string | null>>;
    }
  | {
      readonly type: "score";
      readonly instructions: string;
      readonly criteria: readonly string[];
    };

export type JudgmentQuestions = Readonly<Record<string, JudgmentQuestion>>;

export type JudgmentAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    }
  | {
      readonly type: "score";
      readonly score: number;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    };

export type JudgmentAnswers = Readonly<Record<string, JudgmentAnswer>>;

export type JudgmentUnavailableReason =
  | "disabled"
  | "not_configured"
  | "invalid_configuration"
  | "budget"
  | "state_denied"
  | "state_too_large"
  | "timeout"
  | "rate_limit"
  | "network"
  | "server"
  | "invalid_response"
  | "model_mismatch"
  | "aborted";

export interface JudgmentClientRequest {
  readonly state: JsonValue;
  readonly questions: JudgmentQuestions;
  /** Names the decision asking; the live client ignores it, recorded fixtures are keyed by it. */
  readonly decision?: { readonly id: string; readonly version: number };
  readonly signal?: AbortSignal;
  /** Overall deadline covering every attempt; hot paths may shorten it. */
  readonly deadlineMs?: number;
}

export type JudgmentClientResult =
  | {
      readonly available: true;
      readonly answers: JudgmentAnswers;
      readonly model: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly durationMs: number;
    }
  | {
      readonly available: false;
      readonly reason: JudgmentUnavailableReason;
      readonly detail?: string;
      /** Present for a model mismatch so the mismatch can be recorded. */
      readonly reportedModel?: string;
      readonly durationMs: number;
    };

export interface JudgmentClient {
  request(request: JudgmentClientRequest): Promise<JudgmentClientResult>;
}

export interface FetchJudgmentClientOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly now?: () => number;
  readonly random?: () => number;
  /** Base for jittered exponential backoff between retries. */
  readonly backoffBaseMs?: number;
}

const probabilitiesSchema = z.record(z.string(), z.number().min(0).max(1));
const unitInterval = z.number().min(0).max(1);

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: unitInterval }).passthrough(),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: probabilitiesSchema,
    confidence: unitInterval,
  }).passthrough(),
  z.object({
    type: z.literal("score"),
    score: z.number().finite(),
    probabilities: probabilitiesSchema,
    confidence: unitInterval,
  }).passthrough(),
]);

const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative().optional(),
  }).passthrough(),
}).passthrough();

/** Rejects answers that do not match the question they answer, so no partial answer escapes. */
function validateAnswers(
  questions: JudgmentQuestions,
  answers: Record<string, z.infer<typeof answerSchema>>,
): string | null {
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!answer) return `response omits question ${id}`;
    if (answer.type !== question.type) return `question ${id} answered as ${answer.type}`;
    if (question.type === "choice" && answer.type === "choice") {
      const options = Object.keys(question.criteria);
      if (!options.includes(answer.choice)) return `question ${id} answered outside its options`;
      if (Object.keys(answer.probabilities).some((option) => !options.includes(option))) {
        return `question ${id} reported probabilities outside its options`;
      }
    }
    if (question.type === "score" && answer.type === "score") {
      if (answer.score < 0 || answer.score > question.criteria.length - 1) {
        return `question ${id} answered outside its rubric`;
      }
    }
  }
  return null;
}

function unavailable(
  reason: JudgmentUnavailableReason,
  durationMs: number,
  extra: { detail?: string; reportedModel?: string } = {},
): JudgmentClientResult {
  return { available: false, reason, durationMs, ...extra };
}

export function createFetchJudgmentClient(options: FetchJudgmentClientOptions): JudgmentClient {
  const doFetch = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? JUDGMENT_ENDPOINT;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const backoffBaseMs = options.backoffBaseMs ?? 200;

  return {
    async request(request) {
      const started = now();
      const elapsed = () => now() - started;
      const deadlineMs = request.deadlineMs ?? JUDGMENT_DEFAULT_DEADLINE_MS;
      if (request.signal?.aborted) return unavailable("aborted", 0);

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, deadlineMs);
      const onCallerAbort = () => controller.abort();
      request.signal?.addEventListener("abort", onCallerAbort, { once: true });

      const stopped = (): JudgmentClientResult =>
        unavailable(timedOut && !request.signal?.aborted ? "timeout" : "aborted", elapsed());

      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const wake = setTimeout(done, ms);
          function done() {
            clearTimeout(wake);
            controller.signal.removeEventListener("abort", done);
            resolve();
          }
          controller.signal.addEventListener("abort", done, { once: true });
        });

      const body = JSON.stringify({
        model: JUDGMENT_MODEL,
        state: request.state,
        questions: request.questions,
      });

      try {
        for (let attempt = 0; ; attempt += 1) {
          let response: Response;
          try {
            response = await doFetch(endpoint, {
              method: "POST",
              headers: {
                authorization: `Bearer ${options.apiKey}`,
                "content-type": "application/json",
              },
              body,
              signal: controller.signal,
            });
          } catch {
            if (controller.signal.aborted) return stopped();
            return unavailable("network", elapsed());
          }

          if (response.status === 429 || response.status === 529) {
            await response.body?.cancel().catch(() => {});
            if (attempt >= JUDGMENT_MAX_RETRIES) return unavailable("rate_limit", elapsed());
            await sleep(backoffBaseMs * 2 ** attempt * (0.5 + random() * 0.5));
            if (controller.signal.aborted) return stopped();
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            return unavailable("server", elapsed(), { detail: `status ${response.status}` });
          }

          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            if (controller.signal.aborted) return stopped();
            return unavailable("invalid_response", elapsed(), { detail: "body is not JSON" });
          }
          const parsed = responseSchema.safeParse(payload);
          if (!parsed.success) {
            return unavailable("invalid_response", elapsed(), { detail: "unexpected response shape" });
          }
          const { model, answers, usage } = parsed.data;
          if (model !== JUDGMENT_MODEL) {
            return unavailable("model_mismatch", elapsed(), { reportedModel: model });
          }
          const problem = validateAnswers(request.questions, answers);
          if (problem) return unavailable("invalid_response", elapsed(), { detail: problem });

          const requested = Object.fromEntries(
            Object.keys(request.questions).map((id) => [id, answers[id]]),
          );
          return {
            available: true,
            answers: requested as JudgmentAnswers,
            model,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens ?? 0,
            durationMs: elapsed(),
          };
        }
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}
