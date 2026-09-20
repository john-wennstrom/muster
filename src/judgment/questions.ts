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

/**
 * context.capsule_ranking: how necessary each slice of a task's context is to completing the
 * task. One rubric question per slice. The wording says what necessity means because a bare
 * "is this relevant?" answers yes to anything in the same area: a file that shares names with
 * the task is related, and only a file the work depends on is needed.
 */
export const CAPSULE_RANKING_LEVELS = ["unrelated", "background", "useful", "required"] as const;

export function capsuleRankingQuestionId(index: number): string {
  return `slice_${index}_necessity`;
}

/** The index a per-slice question identifier names, or null for any other identifier. */
export function parseCapsuleRankingQuestionId(id: string): number | null {
  const match = /^slice_(\d+)_necessity$/.exec(id);
  return match ? Number(match[1]) : null;
}

const sliceReference = (index: number): string =>
  `slice ${index}, the entry with index ${index} in the state's slices list`;

/** One necessity rubric per slice, in slice order. */
export function capsuleRankingQuestions(sliceCount: number): readonly QuestionEntry[] {
  const entries: QuestionEntry[] = [];
  for (let index = 1; index <= sliceCount; index += 1) {
    entries.push([
      capsuleRankingQuestionId(index),
      score(
        `How necessary is ${sliceReference(index)}, to completing the task described in the state? Necessity means the slice is needed to do the work, not that it is topically related to the task: a slice that shares names or sits in the same area but that the work does not depend on is at most background. Judge each slice on its own, without regard to the other slices.`,
        [
          "Unrelated: the work does not touch or depend on this slice.",
          "Background: related to the task, but the work can be done correctly without reading it.",
          "Useful: the work is easier or safer with this slice, but could proceed without it.",
          "Required: the work cannot be done correctly without this slice.",
        ],
      ),
    ]);
  }
  return entries;
}

/**
 * review.task_focus: where a task's code reviewer should look first. Six yes/no questions over
 * the review inputs and one rubric on impact outside the diff. Each question states its own
 * boundary because the service reads literally. The first four are worded so that a good
 * change answers yes, and the last two so that a good change answers no; the gate's
 * thresholds depend on that direction.
 */
export const TASK_FOCUS_QUESTION_IDS = {
  scopeContainment: "scope_containment",
  contractMatch: "contract_match",
  scenarioCoverage: "scenario_coverage",
  testFirstConsistency: "test_first_consistency",
  stubOrHardcoded: "stub_or_hardcoded",
  securityBoundary: "security_boundary",
  reach: "reach",
} as const;

export const TASK_FOCUS_REACH_LEVELS = ["none", "callers", "modules", "external"] as const;

export const taskFocusQuestions: readonly QuestionEntry[] = [
  [
    TASK_FOCUS_QUESTION_IDS.scopeContainment,
    noul(
      "Is every file in the state's changed paths inside the write scopes the state authorizes, so that the change stays within what the task was allowed to touch? A changed path that matches none of the write scopes answers no. Reading a file outside the write scopes is not a change and does not count.",
    ),
  ],
  [
    TASK_FOCUS_QUESTION_IDS.contractMatch,
    noul(
      "Does the diff implement what the task contract's definition and requirements describe, neither leaving a stated requirement undone nor doing materially different work than the contract states? A diff that does the described work and also makes an unrelated change still answers yes here; judge only whether the described work is done.",
    ),
  ],
  [
    TASK_FOCUS_QUESTION_IDS.scenarioCoverage,
    noul(
      "Do the tests shown in the state's test evidence exercise every scenario the task contract lists, so that each scenario would fail if the behavior it describes were absent? A scenario with no test that exercises it answers no, and passing tests that exercise only other behavior do not count.",
    ),
  ],
  [
    TASK_FOCUS_QUESTION_IDS.testFirstConsistency,
    noul(
      "Is the test-first evidence in the state coherent with the diff, so that it shows a test that failed before the change for the behavior the diff adds, and then passed after it? Evidence that is missing where the contract required it, that shows a failure unrelated to the changed behavior, or that does not match the diff answers no.",
    ),
  ],
  [
    TASK_FOCUS_QUESTION_IDS.stubOrHardcoded,
    noul(
      "Does the diff add a stub, a placeholder, or a hard-coded value that stands in for real behavior, such as a function that returns a constant so a test passes, a TODO in place of logic, or an expected value copied into the code? Constants that are the actual specified behavior, and stubs inside test code that isolate a dependency, answer no.",
    ),
  ],
  [
    TASK_FOCUS_QUESTION_IDS.securityBoundary,
    noul(
      "Does the diff change what an actor is allowed to do, or what the system trusts: authentication, authorization, permissions, credential handling, path or command construction from untrusted input, or the validation of untrusted input? A change that merely touches code near such logic without changing what is allowed or trusted answers no.",
    ),
  ],
  [
    TASK_FOCUS_QUESTION_IDS.reach,
    score(
      "How far does the effect of the diff reach beyond the files it changes?",
      [
        "None: the change is confined to the changed files and nothing else depends on the changed behavior.",
        "Callers: code that calls the changed functions in the same module is affected.",
        "Modules: several modules or capabilities in this repository depend on the changed behavior.",
        "External: consumers outside this repository, or the way the whole system operates, are affected.",
      ],
    ),
  ],
];

/**
 * command.classification: which manual-approval category, if any, a host command belongs to.
 * The category is one choice, with each option defined by what the command does to state that
 * cannot be taken back or that lies beyond this machine, because a bare "is this dangerous?"
 * answers yes to anything with a scary name. The state is only the command line, so the
 * wording tells the service to judge what the command line plainly does and to answer none
 * when it names no effect. The three yes/no questions are recorded with the call and never
 * gated, so calibration can show where they and the category disagree.
 */
export const COMMAND_QUESTION_IDS = {
  category: "category",
  irreversible: "irreversible",
  remoteMutation: "remote_mutation",
  credentialUse: "credential_use",
} as const;

export const COMMAND_CATEGORIES = [
  "none",
  "authentication",
  "elevated_permission",
  "destructive",
  "external_side_effect",
] as const;
export type CommandCategoryChoice = (typeof COMMAND_CATEGORIES)[number];

export const commandQuestions: readonly QuestionEntry[] = [
  [
    COMMAND_QUESTION_IDS.category,
    choice(
      "Given the command line in the state (the executable, its arguments, the working directory relative to the worktree, and the command profile), which manual-approval category does running it belong to? Judge what the command line plainly does or would plainly cause, such as a package script named for publishing or deploying, or a package or file the executable is told to run. Choose none for building, testing, formatting, reading, and other work that changes only files inside the worktree and can be undone by restoring them; choose none when the command line names no effect beyond that. Where two categories apply, choose the one whose effect is hardest to undo.",
      {
        none: "Changes at most files inside the worktree, and everything it changes can be undone by restoring those files.",
        authentication: "Signs in, signs out, or creates, refreshes, or stores credentials or a login session with a service or registry.",
        elevated_permission: "Runs with more privilege than the current user has, or changes who is permitted to do what, such as privilege escalation or changing ownership or access on files or accounts.",
        destructive: "Permanently deletes or overwrites data that cannot be restored from the worktree, or discards work that exists nowhere else, inside or outside the worktree.",
        external_side_effect: "Changes something outside this machine that other people or systems can see or depend on, such as publishing a package, deploying, releasing, or sending a message or request that mutates a remote system.",
      },
    ),
  ],
  [
    COMMAND_QUESTION_IDS.irreversible,
    noul(
      "Would the effect of running this command line be impossible to undo by restoring files in the worktree, such as data deleted from elsewhere, a published artifact, or a message sent? A command that only writes, moves, or deletes files that the worktree's version control can restore answers no.",
    ),
  ],
  [
    COMMAND_QUESTION_IDS.remoteMutation,
    noul(
      "Does running this command line change something on a remote system or service, as opposed to only reading from one? Downloading or installing packages and fetching data answers no; publishing, deploying, pushing, or posting answers yes.",
    ),
  ],
  [
    COMMAND_QUESTION_IDS.credentialUse,
    noul(
      "Does this command line use, create, or handle a credential, such as a token, password, key, or login session, or does it sign in to a service? Merely running a program that a credential might exist for, without the command line involving one, answers no.",
    ),
  ],
];

/**
 * review.extraction: what a planning reviewer's prose response amounts to as a review. One
 * choice gives the verdict the response as a whole reaches, and one choice per candidate line
 * says how that line functions. Every option is defined by whether the line or the response
 * raises a problem that blocks the plan, because the service reads literally: praise, a
 * restatement of the task, and a description of what the reviewer read raise nothing, and a
 * line that only suggests an improvement is not a blocking problem however strongly it is
 * worded. The service classifies lines it is shown and writes none.
 */
export const REVIEW_EXTRACTION_QUESTION_IDS = {
  verdict: "verdict",
} as const;

export const REVIEW_EXTRACTION_VERDICTS = ["approve", "revise", "unclear"] as const;
export type ReviewExtractionVerdictChoice = (typeof REVIEW_EXTRACTION_VERDICTS)[number];

export const REVIEW_EXTRACTION_LINE_KINDS = [
  "critical",
  "required",
  "recommendation",
  "not_a_finding",
] as const;
export type ReviewExtractionLineKind = (typeof REVIEW_EXTRACTION_LINE_KINDS)[number];

export function reviewExtractionLineQuestionId(index: number): string {
  return `line_${index}_kind`;
}

/** The index a per-line question identifier names, or null for any other identifier. */
export function parseReviewExtractionLineQuestionId(id: string): number | null {
  const match = /^line_(\d+)_kind$/.exec(id);
  return match ? Number(match[1]) : null;
}

const lineReference = (index: number): string =>
  `line ${index}, the entry with index ${index} in the state's candidates list`;

/** One verdict choice, then one kind choice per candidate line, in line order. */
export function reviewExtractionQuestions(candidateCount: number): readonly QuestionEntry[] {
  const entries: QuestionEntry[] = [
    [
      REVIEW_EXTRACTION_QUESTION_IDS.verdict,
      choice(
        "The state's response is a reviewer's written review of a plan, and the candidates are its lines. What verdict does the response as a whole reach? Choose approve only when the reviewer clearly concludes the plan can proceed and raises no problem that must be fixed first. Choose revise only when the reviewer raises at least one problem that must be fixed before the plan proceeds. Choose unclear when the response reaches no conclusion, is reasoning or narration without a conclusion, or contradicts itself about whether the plan can proceed. Do not infer a verdict the reviewer did not state.",
        {
          approve: "The reviewer concludes the plan can proceed, and raises no problem that must be fixed first.",
          revise: "The reviewer raises at least one problem that must be fixed before the plan proceeds.",
          unclear: "The response reaches no conclusion, is reasoning or narration, or contradicts itself about whether the plan can proceed.",
        },
      ),
    ],
  ];
  for (let index = 1; index <= candidateCount; index += 1) {
    entries.push([
      reviewExtractionLineQuestionId(index),
      choice(
        `How does ${lineReference(index)}, function in the review? Judge only what this line says. A line that praises the plan, restates what the plan does, describes what the reviewer read or checked, or introduces a section is not a finding. A line that suggests an optional improvement is a recommendation even when it is worded forcefully. Where a line could be a required change or a recommendation, choose by whether the reviewer says the plan cannot proceed without it.`,
        {
          critical: "Raises a defect that blocks the plan: something wrong, missing, or unsafe that makes it unworkable as written.",
          required: "States a change that must be made before implementation starts, without which the plan should not proceed.",
          recommendation: "Suggests an optional improvement or raises a minor point that does not stop the plan from proceeding.",
          not_a_finding: "Narration, praise, a restatement of the task, a description of what was read, a heading, or a preamble; it raises nothing.",
        },
      ),
    ]);
  }
  return entries;
}
