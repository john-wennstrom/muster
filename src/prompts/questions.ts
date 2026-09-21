import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { JudgmentQuestion } from "../judgment/client.ts";
import { validateQuestions, type QuestionEntry } from "../judgment/questions.ts";
import { HarnessError } from "../shared/errors.ts";
import { PROMPTS_ROOT } from "./render.ts";

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

const questionSchema = z.object({
  id: z.string(),
  type: z.enum(["noul", "choice", "score"]),
  instructions: z.string(),
  criteria: z.unknown().optional(),
}).strict();

const repeatSchema = z.object({ repeat: z.string() }).strict().or(
  z.object({ repeat: z.string(), id: z.string(), type: z.enum(["noul", "choice", "score"]), instructions: z.string(), criteria: z.unknown().optional() }).strict(),
).or(
  z.object({ repeat: z.string(), questions: z.array(questionSchema).min(1) }).strict(),
);

const fileSchema = z.object({
  decision: z.string(),
  questions: z.array(z.union([questionSchema, repeatSchema])).min(1),
}).strict();

type Scope = Readonly<Record<string, string | number>>;
type QuestionSource = z.infer<typeof questionSchema>;

function invalid(decision: string, message: string): never {
  throw new HarnessError(
    "JUDGMENT_QUESTION_INVALID",
    `Judgment decision ${decision}: ${message}`,
    { decision, question: null },
  );
}

function substitute(decision: string, text: string, scope: Scope): string {
  return text.replace(PLACEHOLDER, (_placeholder, name: string) => {
    if (!Object.hasOwn(scope, name)) invalid(decision, `question text uses unknown variable {{${name}}}`);
    return String(scope[name]);
  });
}

function substituteDeep(decision: string, value: unknown, scope: Scope): unknown {
  if (typeof value === "string") return substitute(decision, value, scope);
  if (Array.isArray(value)) return value.map((item) => substituteDeep(decision, item, scope));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteDeep(decision, item, scope)]),
    );
  }
  return value;
}

function entryFor(decision: string, source: QuestionSource, scope: Scope): QuestionEntry {
  const question = {
    type: source.type,
    instructions: substitute(decision, source.instructions, scope),
    ...(source.criteria === undefined ? {} : { criteria: substituteDeep(decision, source.criteria, scope) }),
  } as JudgmentQuestion;
  return [substitute(decision, source.id, scope), question];
}

function itemScope(decision: string, list: string, item: unknown, index: number, variables: Scope): Scope {
  if (item !== null && typeof item === "object") {
    const fields = Object.entries(item).filter(([, value]) => typeof value === "string" || typeof value === "number");
    return { ...variables, ...Object.fromEntries(fields) as Scope, index };
  }
  if (typeof item === "string" || typeof item === "number") return { ...variables, item, index };
  return invalid(decision, `item ${index} of ${list} is not an object or a value`);
}

/** Loads decision question files from one directory and expands them into validated entries. */
export function createQuestionLoader(directory: string) {
  const cache = new Map<string, z.infer<typeof fileSchema>>();
  const read = (decision: string): z.infer<typeof fileSchema> => {
    const cached = cache.get(decision);
    if (cached) return cached;
    const path = resolve(directory, `${decision}.yaml`);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (cause) {
      return invalid(decision, `question file ${path} cannot be read (${cause instanceof Error ? cause.message : String(cause)})`);
    }
    const parsed = fileSchema.safeParse(parseYaml(source));
    if (!parsed.success) {
      return invalid(decision, `question file ${path} is malformed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    if (parsed.data.decision !== decision) {
      invalid(decision, `question file ${path} declares decision ${parsed.data.decision}`);
    }
    cache.set(decision, parsed.data);
    return parsed.data;
  };

  return (decision: string, variables: Readonly<Record<string, unknown>> = {}): readonly QuestionEntry[] => {
    const file = read(decision);
    const scalars = Object.fromEntries(
      Object.entries(variables).filter(([, value]) => typeof value === "string" || typeof value === "number"),
    ) as Scope;
    const entries: QuestionEntry[] = [];
    for (const source of file.questions) {
      if (!("repeat" in source)) {
        entries.push(entryFor(decision, source, scalars));
        continue;
      }
      const items = variables[source.repeat];
      if (!Array.isArray(items)) invalid(decision, `repeat list ${source.repeat} was not supplied as a list`);
      items.forEach((item, position) => {
        const scope = itemScope(decision, source.repeat, item, position + 1, scalars);
        if ("questions" in source) {
          for (const question of source.questions) entries.push(entryFor(decision, question, scope));
        } else {
          entries.push(entryFor(decision, source as QuestionSource, scope));
        }
      });
    }
    validateQuestions(decision, entries);
    return entries;
  };
}

/** Builds a decision's questions from `prompts/judgment/<decision>.yaml`. */
export const loadQuestions = createQuestionLoader(resolve(PROMPTS_ROOT, "judgment"));
