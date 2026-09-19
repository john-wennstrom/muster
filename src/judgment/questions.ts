import { createHash } from "node:crypto";
import { HarnessError } from "../shared/errors.ts";
import type { JudgmentQuestion, JudgmentQuestions } from "./client.ts";

/**
 * Question helpers and validation. Question wording for each decision also lives in this
 * file, one reviewable place: the service reads questions literally, so a wording change is
 * reviewed like a prompt change, and negation and scoping belong in the wording, not in a
 * comment. Each decision's questions are appended here by the change that adds the decision.
 */

export type QuestionEntry = readonly [id: string, question: JudgmentQuestion];

export function noul(
  instructions: string,
  criteria?: { readonly true?: string; readonly false?: string },
): JudgmentQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

export function choice(
  instructions: string,
  criteria: Readonly<Record<string, string | null>>,
): JudgmentQuestion {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: string, criteria: readonly string[]): JudgmentQuestion {
  return { type: "score", instructions, criteria };
}

function invalid(decision: string, question: string | null, message: string): never {
  throw new HarnessError(
    "JUDGMENT_QUESTION_INVALID",
    `Judgment decision ${decision}${question === null ? "" : `, question ${question}`}: ${message}`,
    { decision, question },
  );
}

/**
 * Rejects a malformed definition as a programming error naming the decision and question.
 * Takes entries rather than a map so a duplicate identifier is representable, and so caught.
 */
export function validateQuestions(
  decision: string,
  entries: readonly QuestionEntry[],
): JudgmentQuestions {
  if (entries.length === 0) invalid(decision, null, "defines no questions");
  const questions: Record<string, JudgmentQuestion> = {};
  for (const [id, question] of entries) {
    if (!id.trim()) invalid(decision, id, "has an empty identifier");
    if (Object.hasOwn(questions, id)) invalid(decision, id, "duplicates a question identifier");
    const type: unknown = question?.type;
    if (type !== "noul" && type !== "choice" && type !== "score") {
      invalid(decision, id, `has unsupported type ${String(type)}`);
    }
    if (typeof question.instructions !== "string" || !question.instructions.trim()) {
      invalid(decision, id, "has empty instructions");
    }
    if (question.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      if (options.length === 0) invalid(decision, id, "is a choice without options");
      if (options.some((option) => !option.trim())) invalid(decision, id, "has an empty option name");
    }
    if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length === 0) {
        invalid(decision, id, "is a rubric without criteria");
      }
      if (question.criteria.some((level) => typeof level !== "string" || !level.trim())) {
        invalid(decision, id, "has an empty rubric criterion");
      }
    }
    questions[id] = question;
  }
  return questions;
}

/** Content hash of a decision's questions, so wording changes are visible and reviewable. */
export function questionsFingerprint(questions: JudgmentQuestions): string {
  return createHash("sha256").update(canonicalize(questions)).digest("hex");
}

/** Key-order-independent JSON, shared with fixture keys so equal content hashes equally. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * planning.complexity: the four risk facts behind complexity classification, plus two
 * recorded-only signals. Each risk question states its own boundary because the service reads
 * literally: a bare "does this involve a migration?" answers yes to "don't migrate the data".
 */
export const COMPLEXITY_QUESTION_IDS = {
  publicContract: "public_contract",
  dataMigration: "data_migration",
  securityBoundary: "security_boundary",
  designAmbiguity: "design_ambiguity",
  mechanical: "mechanical",
  reach: "reach",
} as const;

export const complexityQuestions: readonly QuestionEntry[] = [
  [
    COMPLEXITY_QUESTION_IDS.publicContract,
    noul(
      "Does the request change an externally observable interface that code outside the changed component depends on, such as a public API, a command-line surface, a file or wire format, a configuration schema, or a protocol between two processes? Changing an internal function signature, a private helper, or the internals of one module is not a public contract change and answers no.",
    ),
  ],
  [
    COMPLEXITY_QUESTION_IDS.dataMigration,
    noul(
      "Does carrying out the request require migrating existing stored data to a new shape or location? A request that explicitly avoids a migration, such as one that says not to migrate the data or to keep existing data as it is, answers no. Adding something that existing data does not need to be rewritten for is not a migration.",
    ),
  ],
  [
    COMPLEXITY_QUESTION_IDS.securityBoundary,
    noul(
      "Does the request change what an actor is allowed to do, or what the system trusts: authentication, authorization, permissions, credential handling, or the validation of untrusted input? Work that merely touches code near such logic without changing what is allowed or trusted answers no.",
    ),
  ],
  [
    COMPLEXITY_QUESTION_IDS.designAmbiguity,
    noul(
      "Would two or more materially different, mutually incompatible designs each be a reasonable reading of this request, so that a design decision must be made before the work can be planned? A request with one obvious approach, or with a stated approach, answers no.",
    ),
  ],
  [
    COMPLEXITY_QUESTION_IDS.mechanical,
    noul(
      "Does the change follow a pattern the request already states or the evidence already shows, so that it can be carried out without any design judgment, such as a rename or applying an existing convention to more places?",
    ),
  ],
  [
    COMPLEXITY_QUESTION_IDS.reach,
    score(
      "How far does the change reach beyond the place where it is made?",
      [
        "Confined to one function or one file, with no effect on callers.",
        "Affects the callers within one module or capability.",
        "Affects several modules or capabilities inside this repository.",
        "Affects consumers outside this repository, or the way the whole system operates.",
      ],
    ),
  ],
];

/**
 * planning.preflight: what planning should do with a request, given candidate files that code
 * retrieved. The disposition is one choice. Each candidate gets two questions, and both ask
 * about implementing or needing to change, never about merely mentioning: a file that shares
 * the request's names is not evidence that the request is already done. The ambiguity rubric
 * is recorded with the call and never gated.
 */
export const PREFLIGHT_QUESTION_IDS = {
  disposition: "disposition",
  ambiguity: "ambiguity",
} as const;

export const PREFLIGHT_DISPOSITIONS = ["proceed", "needs_clarification", "already_satisfied"] as const;
export type PreflightDisposition = (typeof PREFLIGHT_DISPOSITIONS)[number];

export type PreflightCandidateQuestionKind = "implements" | "needs_change";

export function preflightCandidateQuestionId(index: number, kind: PreflightCandidateQuestionKind): string {
  return `candidate_${index}_${kind}`;
}

/** The index and kind a per-candidate question identifier names, or null for any other identifier. */
export function parsePreflightCandidateQuestionId(
  id: string,
): { readonly index: number; readonly kind: PreflightCandidateQuestionKind } | null {
  const match = /^candidate_(\d+)_(implements|needs_change)$/.exec(id);
  return match ? { index: Number(match[1]), kind: match[2] as PreflightCandidateQuestionKind } : null;
}

const candidateReference = (index: number): string =>
  `candidate ${index}, the entry with index ${index} in the state's candidates list`;

/** One disposition choice, one ambiguity rubric, and two questions per candidate. */
export function preflightQuestions(candidateCount: number): readonly QuestionEntry[] {
  const entries: QuestionEntry[] = [
    [
      PREFLIGHT_QUESTION_IDS.disposition,
      choice(
        "Given the request and the candidate files in the state, what should planning do? Choose already_satisfied only when the candidates show that the code already does what the request asks. A candidate that only mentions the same names or sits in the same area does not satisfy the request. Choose needs_clarification only when the request is too ambiguous to bound a plan, not merely because it is large.",
        {
          proceed: "The request asks for work the code does not already do, and it is specific enough to plan.",
          needs_clarification: "The request is too ambiguous to bound a plan without asking the user one question.",
          already_satisfied: "The code shown already does what the request asks.",
        },
      ),
    ],
    [
      PREFLIGHT_QUESTION_IDS.ambiguity,
      score(
        "How ambiguous is the request as a basis for planning?",
        [
          "Specific: one clear reading, and the work can be bounded now.",
          "Mostly specific: minor details are open but do not change the plan.",
          "Ambiguous: two or more materially different readings would each need a different plan.",
          "Underspecified: the plan cannot be bounded without asking the user a question.",
        ],
      ),
    ],
  ];
  for (let index = 1; index <= candidateCount; index += 1) {
    entries.push(
      [
        preflightCandidateQuestionId(index, "implements"),
        noul(
          `Does ${candidateReference(index)}, already implement what the request asks for, so that the requested behavior exists there today? A file that only mentions the same names, sits in the same area, or would need to be changed to deliver the request answers no.`,
        ),
      ],
      [
        preflightCandidateQuestionId(index, "needs_change"),
        noul(
          `Would ${candidateReference(index)}, need to be modified to carry out the request? A file that already implements the request without needing a change, or that only mentions the same names, answers no.`,
        ),
      ],
    );
  }
  return entries;
}
