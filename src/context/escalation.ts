import { CAPSULE_AUTHORIZE_AT, CAPSULE_AUTHORIZE_CONFIDENCE } from "../judgment/gates.ts";
import type { TaskCapsule } from "./assembler.ts";

export interface ContextEscalationSource {
  id: string;
  content: string;
  tokenEstimate: number;
}

export interface ContextEscalationRequest {
  runId: string;
  taskId: string;
  sourceId: string;
  reason: string;
  remainingTokens: number;
}

export interface ContextEscalationUsage {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  sourceId: string;
  inputTokens: number;
  measurement: "estimated";
}

export type ContextEscalationResult =
  | {
      allowed: true;
      sourceId: string;
      content: string;
      usage: ContextEscalationUsage;
    }
  | {
      allowed: false;
      sourceId: string;
      reason: string;
    };

export interface EscalateContextOptions {
  capsule: TaskCapsule;
  request: ContextEscalationRequest;
  sources: Readonly<Record<string, ContextEscalationSource>>;
  authorize: (request: ContextEscalationRequest, source: ContextEscalationSource) => boolean | Promise<boolean>;
}

export async function escalateContext(
  options: EscalateContextOptions,
): Promise<ContextEscalationResult> {
  const { capsule, request } = options;
  if (!request.reason.trim()) {
    return { allowed: false, sourceId: request.sourceId, reason: "Context escalation requires a reason" };
  }
  if (capsule.excluded.includes(request.sourceId)) {
    return { allowed: false, sourceId: request.sourceId, reason: "Requested context is explicitly excluded" };
  }
  if (!capsule.available.includes(request.sourceId)) {
    return { allowed: false, sourceId: request.sourceId, reason: "Requested context is not available to this task" };
  }
  const source = options.sources[request.sourceId];
  if (!source || source.id !== request.sourceId) {
    return { allowed: false, sourceId: request.sourceId, reason: "Requested context source is unavailable" };
  }
  if (!Number.isInteger(source.tokenEstimate) || source.tokenEstimate < 0) {
    return { allowed: false, sourceId: request.sourceId, reason: "Requested context has invalid usage metadata" };
  }
  if (source.tokenEstimate > request.remainingTokens) {
    return {
      allowed: false,
      sourceId: request.sourceId,
      reason: `Requested context requires ${source.tokenEstimate} tokens but only ${request.remainingTokens} remain`,
    };
  }
  if (!await options.authorize(request, source)) {
    return { allowed: false, sourceId: request.sourceId, reason: "Requested context is not authorized for this task" };
  }
  return {
    allowed: true,
    sourceId: source.id,
    content: source.content,
    usage: {
      schemaVersion: 1,
      runId: request.runId,
      taskId: request.taskId,
      sourceId: source.id,
      inputTokens: source.tokenEstimate,
      measurement: "estimated",
    },
  };
}

/**
 * Builds the `authorize` callback for `escalateContext` from a capsule's stored ranking. It
 * approves only a slice the capsule lists as available, within the remaining tokens, that the
 * ranking scored at the bar or above with enough confidence; a slice with no ranking is never
 * approved on the ranking's account. `escalateContext` runs every refusal check before it
 * calls the callback, so this can only approve among what a task could already request: it
 * narrows nothing that was allowed and widens nothing that was refused.
 */
export function authorizeFromRanking(capsule: TaskCapsule): EscalateContextOptions["authorize"] {
  return (request, source) => {
    if (!capsule.available.includes(source.id) || source.tokenEstimate > request.remainingTokens) return false;
    const ranking = capsule.ranking;
    if (!ranking || !Object.hasOwn(ranking, source.id)) return false;
    const entry = ranking[source.id]!;
    return entry.score >= CAPSULE_AUTHORIZE_AT && entry.confidence >= CAPSULE_AUTHORIZE_CONFIDENCE;
  };
}
