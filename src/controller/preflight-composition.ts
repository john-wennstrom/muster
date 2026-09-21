import { TRIAGE_RELEVANCE_FLOOR, type TriageGateValue } from "../judgment/decisions/change-triage.ts";

/**
 * Turns a confident triage disposition into the preflight result the planning phase already
 * handles, so nothing downstream can tell which path produced it. Everything here is a template
 * over structured answers: judgment writes no text, and code composes only what the answers and
 * the retrieved candidates already say.
 */

export const MAX_PREFLIGHT_EVIDENCE = 8;

/** The question the blocked outcome carries for an already-satisfied disposition. */
export const STANDARD_ALREADY_SATISFIED_QUESTION =
  "Which branch, deployment, or entry point still exhibits the behavior you want changed?";

export interface PreflightCandidate {
  readonly path: string;
  readonly matchedTerms: readonly string[];
}

/** A triage gate value whose disposition may act. */
export type ActingTriage = Pick<TriageGateValue, "candidates"> & {
  readonly disposition: "proceed" | "already_satisfied";
};

export interface ComposedPreflight {
  readonly disposition: ActingTriage["disposition"];
  readonly summary: string;
  readonly evidence: { path: string; reason: string }[];
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Evidence is every candidate judged relevant at the floor or above, most relevant first, at
 * most eight; ties keep candidate order. Each reason states how the file was found and how
 * likely it was judged to matter. `candidates` is the list judgment was asked about, in the
 * order its answers index into.
 */
export function composePreflight(
  value: ActingTriage,
  candidates: readonly PreflightCandidate[],
): ComposedPreflight {
  const relevant = value.candidates
    .filter(({ index, relevance }) =>
      relevance >= TRIAGE_RELEVANCE_FLOOR && candidates[index - 1] !== undefined)
    .sort((left, right) => right.relevance - left.relevance || left.index - right.index)
    .slice(0, MAX_PREFLIGHT_EVIDENCE);
  const evidence = relevant.map(({ index, relevance }) => {
    const candidate = candidates[index - 1]!;
    return {
      path: candidate.path,
      reason: `Matched ${candidate.matchedTerms.join(", ")}; judged relevant to the request (probability ${relevance.toFixed(2)}).`,
    };
  });
  const retrieved = plural(candidates.length, "candidate file");
  if (value.disposition === "already_satisfied") {
    const implementing = value.candidates.filter(({ implements: implemented }) =>
      implemented >= TRIAGE_RELEVANCE_FLOOR).length;
    return {
      disposition: "already_satisfied",
      summary: `Judged already satisfied by the checked-out code: ${implementing} of ${retrieved} retrieved already implement the request.`,
      evidence,
    };
  }
  return {
    disposition: "proceed",
    summary: `Judged ready to plan: ${relevant.length} of ${retrieved} retrieved are relevant to the request.`,
    evidence,
  };
}
