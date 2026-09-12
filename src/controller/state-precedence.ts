import { isDeepStrictEqual } from "node:util";
import type {
  OpenSpecApplyInstructions,
  OpenSpecStatus,
} from "../openspec/protocol.ts";
import { HarnessError } from "../shared/errors.ts";

export interface RepositoryState {
  repositoryId: string;
  worktree: string;
  head: string;
  diffDigest: string;
}

export interface RuntimeState extends Partial<RepositoryState> {
  runId?: string;
  changeName?: string;
  schemaName?: string;
  applyState?: string;
  tasks?: OpenSpecApplyInstructions["tasks"];
  [key: string]: unknown;
}

export interface SupplementalState {
  source: string;
  changeName?: string;
  schemaName?: string;
  applyState?: string;
  tasks?: OpenSpecApplyInstructions["tasks"];
  repositoryId?: string;
  worktree?: string;
  head?: string;
  diffDigest?: string;
  [key: string]: unknown;
}

export interface StatePrecedenceInput {
  openSpec: {
    status: OpenSpecStatus;
    apply: OpenSpecApplyInstructions;
  };
  repository: RepositoryState;
  runtime?: RuntimeState;
  supplemental?: SupplementalState[];
}

export interface StateConflict {
  field: string;
  authoritativeSource: "openspec" | "repository";
  ignoredSource: string;
  authoritativeValue: unknown;
  ignoredValue: unknown;
  resolution: "ignored-lower-authority";
}

const openSpecFields = ["changeName", "schemaName", "applyState", "tasks"] as const;
const repositoryFields = ["repositoryId", "worktree", "head", "diffDigest"] as const;
const authoritativeFields = new Set<string>([...openSpecFields, ...repositoryFields]);

function supplementalOnly<T extends Record<string, unknown>>(state: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(state).filter(([field]) => !authoritativeFields.has(field)),
  ) as Partial<T>;
}

export function resolveCurrentState(input: StatePrecedenceInput) {
  const { status, apply } = input.openSpec;
  if (status.changeName !== apply.changeName || status.schemaName !== apply.schemaName) {
    throw new HarnessError(
      "STATE_OBSERVATION_CONFLICT",
      "Validated OpenSpec status and apply observations describe different changes or schemas",
      {
        status: { changeName: status.changeName, schemaName: status.schemaName },
        apply: { changeName: apply.changeName, schemaName: apply.schemaName },
      },
    );
  }

  const authoritative: Record<string, unknown> = {
    changeName: status.changeName,
    schemaName: status.schemaName,
    applyState: apply.state,
    tasks: apply.tasks,
    ...input.repository,
  };
  const conflicts: StateConflict[] = [];

  const inspect = (source: string, state: Record<string, unknown>): void => {
    for (const field of authoritativeFields) {
      if (!(field in state) || isDeepStrictEqual(state[field], authoritative[field])) continue;
      conflicts.push({
        field,
        authoritativeSource: openSpecFields.includes(field as (typeof openSpecFields)[number])
          ? "openspec"
          : "repository",
        ignoredSource: source,
        authoritativeValue: authoritative[field],
        ignoredValue: state[field],
        resolution: "ignored-lower-authority",
      });
    }
  };

  if (input.runtime) inspect("runtime", input.runtime);
  for (const supplemental of input.supplemental ?? []) {
    inspect(supplemental.source, supplemental);
  }

  return {
    changeName: status.changeName,
    schemaName: status.schemaName,
    applyState: apply.state,
    tasks: apply.tasks,
    repository: input.repository,
    runtime: input.runtime ? supplementalOnly(input.runtime) : undefined,
    supplemental: (input.supplemental ?? []).map((state) => supplementalOnly(state)),
    conflicts,
  };
}