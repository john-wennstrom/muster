import type { ChangeAction } from "../controller/action-resolver.ts";

/** How an action's argument remainder is interpreted after the action word. */
export type ChangeArgumentShape =
  /** The whole remainder is one free-text prompt; no change slug is parsed out of it. */
  | "free-text"
  /** A change slug followed by free text. */
  | "change+text"
  /** A change slug and nothing the action reads. */
  | "change-only"
  /** A change slug followed by exactly one checkpoint identifier. */
  | "checkpoint-id";

export type ChangeRequirement = "none" | "optional" | "required";

/** Whether the action reuses a change's stable run namespace or gets a fresh identity. */
export type RunIdentityKind = "none" | "per-invocation" | "per-change";

export interface ChangeCommandSpec {
  args: ChangeArgumentShape;
  change: ChangeRequirement;
  lifecycleGated: boolean;
  /** Read-only actions never persist the named change as the active one. */
  readOnly: boolean;
  runIdentity: RunIdentityKind;
  /** Lowest and highest accepted count of arguments following the change slug; null is unbounded. */
  arity: { min: number; max: number | null };
  usage: string;
  /** Whether the argument right after the change name may be `lane=<small|medium|large>`. */
  laneOption?: true;
}

export const changeCommands = {
  explore: {
    args: "free-text",
    change: "none",
    lifecycleGated: false,
    readOnly: true,
    runIdentity: "none",
    arity: { min: 1, max: null },
    usage: "/change explore <prompt>",
  },
  propose: {
    args: "change+text",
    change: "optional",
    lifecycleGated: false,
    readOnly: false,
    runIdentity: "per-invocation",
    arity: { min: 0, max: null },
    usage: "/change propose <change> [lane=small|medium|large] <goal>",
    laneOption: true,
  },
  refine: {
    args: "change+text",
    change: "required",
    lifecycleGated: true,
    readOnly: false,
    runIdentity: "per-invocation",
    arity: { min: 0, max: null },
    usage: "/change refine <change> [lane=small|medium|large] [guidance]",
    laneOption: true,
  },
  review: {
    args: "change+text",
    change: "required",
    lifecycleGated: true,
    readOnly: false,
    runIdentity: "per-invocation",
    arity: { min: 0, max: null },
    usage: "/change review <change> [guidance]",
  },
  implement: {
    args: "change-only",
    change: "required",
    lifecycleGated: true,
    readOnly: false,
    runIdentity: "per-change",
    arity: { min: 0, max: null },
    usage: "/change implement <change>",
  },
  verify: {
    args: "change-only",
    change: "required",
    lifecycleGated: true,
    readOnly: false,
    runIdentity: "per-change",
    arity: { min: 0, max: null },
    usage: "/change verify <change>",
  },
  finish: {
    args: "change-only",
    change: "required",
    lifecycleGated: true,
    readOnly: false,
    runIdentity: "per-change",
    arity: { min: 0, max: null },
    usage: "/change finish <change>",
  },
  status: {
    args: "change-only",
    change: "required",
    lifecycleGated: true,
    readOnly: true,
    runIdentity: "none",
    arity: { min: 0, max: null },
    usage: "/change status [change]",
  },
  resume: {
    args: "checkpoint-id",
    change: "required",
    lifecycleGated: true,
    readOnly: false,
    runIdentity: "per-change",
    arity: { min: 1, max: 1 },
    usage: "/change resume <change> <checkpoint-id>",
  },
} as const satisfies Record<ChangeAction, ChangeCommandSpec>;

export const changeSubcommands = Object.keys(changeCommands) as readonly ChangeAction[];

export function changeCommandSpec(action: ChangeAction): ChangeCommandSpec {
  return changeCommands[action];
}

export function isChangeAction(value: string): value is ChangeAction {
  return Object.hasOwn(changeCommands, value);
}

export function acceptsArity(spec: ChangeCommandSpec, count: number): boolean {
  return count >= spec.arity.min && (spec.arity.max === null || count <= spec.arity.max);
}
