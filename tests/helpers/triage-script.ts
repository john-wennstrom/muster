import type { JudgmentAnswers } from "../../src/judgment/client.ts";

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const reach = (score: number) => ({
  type: "score" as const,
  score,
  probabilities: { "0": 0.1, "1": 0.2, "2": 0.4, "3": 0.3 },
  confidence: 0.8,
});

/** A disposition below the floor, so triage's answers change the lane and the classification but never skip the agent. */
const undecided = { type: "choice" as const, choice: "proceed", probabilities: { proceed: 0.5 }, confidence: 0.5 };

const answersByRequest: Readonly<Record<string, JudgmentAnswers>> = {
  "don't migrate the data, just add a column": {
    disposition: undecided, public_contract: noul(0.1), data_migration: noul(0.04), security_boundary: noul(0.02),
    design_ambiguity: noul(0.08), mechanical: noul(0.85), reach: reach(1.2),
  },
  "rename an internal function signature in the parser": {
    disposition: undecided, public_contract: noul(0.06), data_migration: noul(0.01), security_boundary: noul(0.01),
    design_ambiguity: noul(0.05), mechanical: noul(0.95), reach: reach(0.6),
  },
  "change the wire format between the broker and the child": {
    disposition: undecided, public_contract: noul(0.93), data_migration: noul(0.12), security_boundary: noul(0.5),
    design_ambiguity: noul(0.22), mechanical: noul(0.1), reach: reach(2.1),
  },
};

/** What the service is expected to answer for three requests whose planning risk inputs are known. */
export function triageAnswersByRequest(request: { readonly state: unknown }): JudgmentAnswers {
  const text = (request.state as { request?: string }).request ?? "";
  const answers = answersByRequest[text];
  if (!answers) throw new Error(`No scripted complexity answers for request: ${text}`);
  return answers;
}
