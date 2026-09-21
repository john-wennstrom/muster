import type { ChildToolRule, ModelSlot, ModelStack } from "./model-stack.ts";

export type ChildAccess = "none" | "read" | "write" | "validator";

export interface ResolvedChildRuntime {
  extensions: string[];
  tools: string[];
}

export const READONLY_TOOLS = "read,grep,find,ls"; // parallel agents share a cwd — concurrent writers would collide
export const FULL_TOOLS = "read,grep,find,ls,bash,edit,write"; // sequential agents (builder, fuser) act freely
// The VALIDATOR reads the project read-only but must WRITE its gate straight to disk:
// piping a gate through a fenced code block truncates it at the first embedded ``` (a
// gate that greps for markdown fences contains one), so the script is written, not pasted.
// `write` is scoped to the run's gate path by the VALIDATOR's system prompt — it still
// never touches the project, and it gets no `edit`/`bash` to mutate one with. The TRIAGE
// turn holds the same toolset while the run's single gate repair is unused (a GATE DEFECT
// diagnosis may rewrite the gate at that one path), then drops to READONLY_TOOLS.
export const VALIDATOR_TOOLS = "read,grep,find,ls,write";

function splitToolCsv(csv: string): string[] {
  return csv.split(",").map((tool) => tool.trim()).filter(Boolean);
}

function dedupeOrdered(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizeToolRule(
  entry: string[] | ChildToolRule | undefined,
  defaultInherit: boolean,
): { inherit: boolean; include: string[]; exclude: string[] } | undefined {
  if (entry === undefined) return undefined;
  if (Array.isArray(entry)) return { inherit: false, include: [...entry], exclude: [] };
  return {
    inherit: entry.inherit ?? defaultInherit,
    include: [...(entry.include ?? [])],
    exclude: [...(entry.exclude ?? [])],
  };
}

function applyToolRule(base: string[], rule: { inherit: boolean; include: string[]; exclude: string[] }): string[] {
  const merged = dedupeOrdered([...base, ...rule.include]);
  if (!rule.exclude.length) return merged;
  const blocked = new Set(rule.exclude);
  return merged.filter((name) => !blocked.has(name));
}

function resolveToolList(globalEntry: string[] | ChildToolRule | undefined, slotEntry: string[] | ChildToolRule | undefined): string[] {
  const globalRule = normalizeToolRule(globalEntry, false);
  const globalResolved = globalRule ? applyToolRule([], globalRule) : [];
  const slotRule = normalizeToolRule(slotEntry, true);
  if (!slotRule) return globalResolved;
  const base = slotRule.inherit ? globalResolved : [];
  return applyToolRule(base, slotRule);
}

/**
 * Resolve child extensions + tools for one invocation.
 *
 * Access controls are owned by orchestration (the caller). Slot config only declares
 * capabilities that MAY be added when that access mode allows them.
 */
export function resolveChildRuntime(stack: Pick<ModelStack, "child">, slot: Pick<ModelSlot, "child">, access: ChildAccess): ResolvedChildRuntime {
  if (access === "none") return { extensions: [], tools: [] };

  const globalChild = stack.child;
  const slotChild = slot.child;
  const extensions = slotChild?.extensions ?? globalChild?.extensions ?? [];
  const readTools = resolveToolList(globalChild?.tools?.read, slotChild?.tools?.read);
  const writeTools = resolveToolList(globalChild?.tools?.write, slotChild?.tools?.write);

  const baseTools =
    access === "write"
      ? splitToolCsv(FULL_TOOLS)
      : access === "validator"
        ? splitToolCsv(VALIDATOR_TOOLS)
        : splitToolCsv(READONLY_TOOLS);

  const externalTools = access === "write" ? [...readTools, ...writeTools] : [...readTools];
  return {
    extensions: [...extensions],
    tools: dedupeOrdered([...baseTools, ...externalTools]),
  };
}
