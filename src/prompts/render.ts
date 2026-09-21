import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { HarnessError } from "../shared/errors.ts";

/** A prompt that came from a template file. The only kind of prompt an agent accepts. */
export type RenderedPrompt = string & { readonly __renderedPrompt: true };

/** The installed package's prompts directory, independent of the working directory. */
export const PROMPTS_ROOT = fileURLToPath(new URL("../../prompts", import.meta.url));

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const RENDERED_MEMORY = 4096;

// A string carries no brand at runtime, so rendered text is remembered by hash. The bound keeps
// the memory of a long session small; a prompt is used soon after it is rendered.
const rendered = new Set<string>();

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function remember(text: string): RenderedPrompt {
  rendered.add(fingerprint(text));
  if (rendered.size > RENDERED_MEMORY) rendered.delete(rendered.values().next().value!);
  return text as RenderedPrompt;
}

/** Whether `value` was produced by a renderer, as opposed to a string built by hand. */
export function isRenderedPrompt(value: unknown): value is RenderedPrompt {
  return typeof value === "string" && rendered.has(fingerprint(value));
}

function invalid(template: string, message: string, details: Record<string, unknown> = {}): never {
  throw new HarnessError("PROMPT_TEMPLATE_INVALID", `Prompt template ${template}: ${message}`, {
    template,
    ...details,
  });
}

interface Template {
  readonly name: string;
  readonly variables: readonly string[];
  readonly body: string;
}

/** Splits a `---` front matter block off a template and returns its declared variables and body. */
export function parseTemplate(name: string, source: string): Template {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) invalid(name, "must start with a front matter block declaring `variables`");
  let front: unknown;
  try {
    front = parseYaml(match[1]!);
  } catch (cause) {
    invalid(name, `front matter is not valid YAML (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  const declared = (front as { variables?: unknown } | null)?.variables;
  if (!Array.isArray(declared) || declared.some((item) => typeof item !== "string" || !VARIABLE_NAME.test(item))) {
    invalid(name, "front matter must declare `variables` as a list of names");
  }
  const variables = declared as string[];
  if (new Set(variables).size !== variables.length) invalid(name, "declares a variable twice");
  const body = source.slice(match[0].length);
  const used = new Set([...body.matchAll(PLACEHOLDER)].map((placeholder) => placeholder[1]!));
  for (const placeholder of used) {
    if (!variables.includes(placeholder)) {
      invalid(name, `the body uses undeclared placeholder {{${placeholder}}}`, { variable: placeholder });
    }
  }
  for (const variable of variables) {
    if (!used.has(variable)) {
      invalid(name, `declared variable ${variable} is never used in the body`, { variable });
    }
  }
  return { name, variables, body };
}

function renderTemplate(template: Template, values: Readonly<Record<string, string>>): string {
  for (const variable of template.variables) {
    if (!Object.hasOwn(values, variable) || typeof values[variable] !== "string") {
      invalid(template.name, `variable ${variable} was not supplied`, { variable });
    }
  }
  for (const variable of Object.keys(values)) {
    if (!template.variables.includes(variable)) {
      invalid(template.name, `variable ${variable} is not declared`, { variable });
    }
  }
  // An empty value is an absent optional block. A placeholder alone on its line disappears with
  // its line break, and any other empty placeholder is simply removed. Runs of blank lines the
  // template's own text is left with are closed up. Non-empty values go in verbatim afterwards,
  // so nothing a caller supplies (a diff, a JSON document) is ever reformatted.
  let body = template.body;
  for (const variable of template.variables) {
    if (values[variable] !== "") continue;
    body = body.replace(new RegExp(`^[ \\t]*\\{\\{${variable}\\}\\}[ \\t]*(?:\\r?\\n|$)`, "gm"), "");
  }
  const withoutEmpty = body
    .replace(PLACEHOLDER, (placeholder, variable: string) => (values[variable] === "" ? "" : placeholder))
    .replace(/(?:[ \t]*\r?\n){3,}/g, "\n\n");
  return withoutEmpty.replace(PLACEHOLDER, (_placeholder, variable: string) => values[variable]!).trim();
}

/** Loads templates from one directory, caching each after its first read. */
export function createPromptRenderer(directory: string) {
  const cache = new Map<string, Template>();
  const load = (name: string): Template => {
    const cached = cache.get(name);
    if (cached) return cached;
    const path = resolve(directory, `${name}.md`);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (cause) {
      invalid(name, `file ${path} cannot be read (${cause instanceof Error ? cause.message : String(cause)})`, { path });
    }
    const template = parseTemplate(name, source);
    cache.set(name, template);
    return template;
  };
  return {
    load,
    render(name: string, variables: Readonly<Record<string, string>> = {}): RenderedPrompt {
      return remember(renderTemplate(load(name), variables));
    },
  };
}

const agentPrompts = createPromptRenderer(resolve(PROMPTS_ROOT, "agents"));

/** Renders `prompts/agents/<name>.md` with the given variables. */
export const renderPrompt = agentPrompts.render;
