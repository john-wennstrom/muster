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