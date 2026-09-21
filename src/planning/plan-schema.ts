import { z } from "zod";
import { taskIdSchema, taskManualSchema } from "../execution/task-schema.ts";
import { embeddedJsonObjects } from "../shared/embedded-json.ts";

/**
 * The plan a planning session returns instead of artifact text. It is data: code validates it
 * completely, then renders every OpenSpec artifact from it. Free-text fields hold Markdown, so
 * prose is not constrained; everything a check has to resolve (names, references, commands,
 * scopes) is structured.
 */

export const CAPABILITY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const singleLine = z.string().min(1).refine((value) => !/[\r\n]/.test(value), "must be a single line");
const markdown = z.string().min(1);
const capabilityName = z.string().regex(CAPABILITY_NAME, "must be a kebab-case name");

export const REQUIREMENT_KINDS = ["ADDED", "MODIFIED", "REMOVED", "RENAMED"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

const scenarioSchema = z.object({
  name: singleLine,
  when: markdown,
  then: markdown,
}).strict();

const requirementSchema = z.object({
  capability: capabilityName,
  name: singleLine,
  /** ADDED when omitted. */
  kind: z.enum(REQUIREMENT_KINDS).optional(),
  /** The requirement text (SHALL or MUST), or for a removal its reason. */
  text: markdown,
  /** At least one for an added or modified requirement. */
  scenarios: z.array(scenarioSchema).optional(),
  /** Required for a removal: how existing users move off it. */
  migration: markdown.optional(),
  /** Required for a rename: the previous name. */
  renamedFrom: singleLine.optional(),
}).strict();

const designSchema = z.object({
  context: markdown,
  goals: z.array(singleLine),
  nonGoals: z.array(singleLine),
  decisions: z.array(z.object({ title: singleLine, body: markdown }).strict()),
  risks: z.array(markdown),
  migration: markdown.optional(),
}).strict();

const taskSchema = z.object({
  id: taskIdSchema,
  /** The heading tasks sharing a number before the dot are listed under. */
  group: singleLine,
  description: singleLine,
  dependsOn: z.array(taskIdSchema),
  role: z.enum(["architect", "builder", "reviewer", "validator", "manual"]).optional(),
  reads: z.array(singleLine),
  writes: z.array(singleLine),
  requirements: z.array(z.object({ capability: capabilityName, name: singleLine }).strict()).min(1),
  scenarios: z.array(singleLine).min(1),
  verify: z.array(singleLine).min(1),
  manual: taskManualSchema.nullable().optional(),
}).strict();

const evidenceSchema = z.array(z.object({ path: singleLine, reason: singleLine }).strict());

const proposalPlanSchema = z.object({
  disposition: z.literal("plan"),
  summary: markdown,
  why: markdown,
  changes: z.array(markdown).min(1),
  capabilities: z.object({
    new: z.array(capabilityName),
    modified: z.array(capabilityName),
  }).strict(),
  impact: z.array(markdown),
  requirements: z.array(requirementSchema).min(1),
  design: designSchema.optional(),
  tasks: z.array(taskSchema).min(1),
}).strict();

const clarificationSchema = z.object({
  disposition: z.literal("needs_clarification"),
  summary: markdown,
  question: singleLine,
  evidence: evidenceSchema,
}).strict();

const satisfiedSchema = z.object({
  disposition: z.literal("already_satisfied"),
  summary: markdown,
  question: singleLine.optional(),
  evidence: evidenceSchema,
}).strict();

export const planSchema = z.discriminatedUnion("disposition", [
  proposalPlanSchema,
  clarificationSchema,
  satisfiedSchema,
]);

export type Plan = z.infer<typeof planSchema>;
export type ProposalPlan = z.infer<typeof proposalPlanSchema>;
export type PlanRequirement = z.infer<typeof requirementSchema>;
export type PlanTask = z.infer<typeof taskSchema>;

/** One thing wrong with a plan, with the path of the field it is about. */
export interface PlanError {
  readonly path: string;
  readonly message: string;
}

export const formatPlanErrors = (errors: readonly PlanError[]): string =>
  errors.map(({ path, message }) => `- ${path}: ${message}`).join("\n");

/** `tasks[1].verify[0]`, not `tasks.1.verify.0`. */
export function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "<plan>";
  return path.reduce<string>((text, part) =>
    typeof part === "number" ? `${text}[${part}]` : text ? `${text}.${String(part)}` : String(part), "");
}

export type ParsedPlan =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly errors: readonly PlanError[] };

/** Extracts exactly one JSON object from a session's answer and checks it against the schema. */
export function parsePlan(text: string): ParsedPlan {
  const objects = embeddedJsonObjects(text.trim());
  if (objects.length !== 1) {
    return {
      ok: false,
      errors: [{ path: "<answer>", message: `expected exactly one JSON object, found ${objects.length}` }],
    };
  }
  const result = planSchema.safeParse(objects[0]);
  if (result.success) return { ok: true, plan: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
  };
}

/** The JSON schema the planning prompt shows the model, generated from the schema that checks its answer. */
export function describePlanSchema(): string {
  return JSON.stringify(z.toJSONSchema(planSchema, { io: "input" }), null, 2);
}
