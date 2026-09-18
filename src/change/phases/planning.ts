import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import {
  type ModelSlot,
  type ModelStack,
} from "../../../extensions/fusion-harness/modules/model-stack.ts";
import { newRun, runError, runOk } from "../../../extensions/fusion-harness/modules/runtime.ts";
import { runLegacyReadOnlyChild } from "../../agents/legacy-adapter.ts";
import {
  propose,
  refine,
  type PlanningAgentRequest,
  type PlanningAgentResult,
  type PlanningArtifactWriteRequest,
  type PlanningPhase,
} from "../../controller/planning.ts";
import { classifyChange } from "../../controller/complexity-router.ts";
import { OpenSpecAdapter } from "../../openspec/adapter.ts";
import type { OpenSpecStatus } from "../../openspec/protocol.ts";
import { createChangeUsageStore, recordChangeUsage } from "../../persistence/change-usage-store.ts";
import { readCliFlag } from "../../shared/cli-flags.ts";
import { isWithin } from "../../shared/paths.ts";
import { HarnessError } from "../../shared/errors.ts";
import { usageFromLegacyRun } from "../../telemetry/usage.ts";
import type { CommandOutcome } from "../command.ts";
import { resolveModelStack } from "../models.ts";
import type { AgentRunObserver } from "../agent-progress.ts";

const PLANNING_TIMEOUT_MS = 30 * 60 * 1000;

const artifactBundleSchema = z.object({
  artifacts: z.array(z.object({
    path: z.string().min(1),
    content: z.string().min(1),
  }).strict()).min(3),
}).strict();

function parseArtifactBundle(content: string): z.infer<typeof artifactBundleSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch (cause) {
    throw new HarnessError(
      "PLANNING_ARTIFACT_INVALID",
      "Planning synthesis did not return one JSON artifact bundle",
      {},
      { cause },
    );
  }
  const result = artifactBundleSchema.safeParse(parsed);
  if (!result.success) {
    throw new HarnessError(
      "PLANNING_ARTIFACT_INVALID",
      "Planning synthesis returned an incompatible artifact bundle",
      { issues: result.error.issues },
    );
  }
  return result.data;
}

function allowedArtifactPath(changeRoot: string, path: string): string {
  if (isAbsolute(path)) {
    throw new HarnessError("PLANNING_ARTIFACT_INVALID", "Planning artifact paths must be relative", { path });
  }
  const normalized = path.replaceAll("\\", "/");
  const fixed = new Set(["proposal.md", "design.md", "tasks.md"]);
  const isSpec = /^specs\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/spec\.md$/.test(normalized);
  if (!fixed.has(normalized) && !isSpec) {
    throw new HarnessError(
      "PLANNING_ARTIFACT_INVALID",
      `Planning synthesis attempted an unsupported artifact path: ${path}`,
      { path },
    );
  }
  const destination = resolve(changeRoot, normalized);
  if (!isWithin(changeRoot, destination)) {
    throw new HarnessError("PLANNING_ARTIFACT_INVALID", "Planning artifact path escapes the change root", { path });
  }
  return destination;
}

function planningPrompt(request: PlanningAgentRequest, status: OpenSpecStatus): string {
  const previous = request.priorResults.length
    ? request.priorResults.map((result, index) => `RESULT ${index + 1} (${result.model})\n${result.content}`).join("\n\n")
    : "None";
  const common = [
    `Phase: ${request.phase}`,
    `Stage: ${request.stage}`,
    `Change: ${request.changeName}`,
    `User request: ${request.prompt}`,
    `Complexity: ${request.complexity.classification} (${request.complexity.reason})`,
    `Current OpenSpec status: ${JSON.stringify(status)}`,
    `Authoritative context: ${JSON.stringify(request.authoritativeContext)}`,
    `Prior results:\n${previous}`,
  ];
  if (request.stage !== "synthesis") {
    return [...common, "Return concise planning analysis for the synthesis agent. Do not edit files."].join("\n\n");
  }
  return [
    ...common,
    "Return exactly one JSON object with this shape: {\"artifacts\":[{\"path\":\"proposal.md\",\"content\":\"...\"},{\"path\":\"design.md\",\"content\":\"...\"},{\"path\":\"specs/<capability>/spec.md\",\"content\":\"...\"},{\"path\":\"tasks.md\",\"content\":\"...\"}]}. Do not use markdown fences.",
    "Use OpenSpec delta-spec headings and four-hash WHEN/THEN scenarios. Every tasks.md checkbox must include adjacent yaml harness-task metadata.",
  ].join("\n\n");
}

function slotForRequest(stack: ModelStack, request: PlanningAgentRequest): ModelSlot {
  if (request.stage === "specialist_opinion" && stack.builders.length > 0) {
    return stack.builders[(request.opinionIndex ?? 0) % stack.builders.length]!;
  }
  return stack.architect;
}

export interface ProductionPlanningOptions {
  onAgentStart?: AgentRunObserver;
  cwd: string;
  changeName: string;
  phase: PlanningPhase;
  runId?: string;
  prompt: string;
  signal?: AbortSignal;
  argv?: readonly string[];
  openSpec?: OpenSpecAdapter;
  modelStack?: ModelStack;
  runAgent?(request: PlanningAgentRequest, status: OpenSpecStatus, slot: ModelSlot): Promise<PlanningAgentResult>;
}

export async function runProductionPlanning(options: ProductionPlanningOptions): Promise<CommandOutcome> {
  const adapter = options.openSpec ?? new OpenSpecAdapter({ cwd: options.cwd, signal: options.signal });
  if (options.phase === "propose") {
    try {
      await adapter.status(options.changeName);
    } catch (error) {
      if (!(error instanceof HarnessError) || error.code !== "OPENSPEC_COMMAND_FAILED") throw error;
      await adapter.createChange(options.changeName, options.prompt || `Plan ${options.changeName}`);
    }
  }
  const status = await adapter.status(options.changeName);
  const changeRoot = resolve(status.changeRoot);
  const stack = options.modelStack ?? resolveModelStack(options.argv);
  const planningRunId = options.runId ?? `${options.phase}-${options.changeName}`;
  const usageStore = createChangeUsageStore(options.cwd);
  const runAgent = options.runAgent ?? (async (request: PlanningAgentRequest, current: OpenSpecStatus, slot: ModelSlot) => {
    const run = newRun(slot.architect ? "ARCHITECT" : "BUILDER", slot.model, slot);
    const childId = `${request.stage}-${request.opinionIndex ?? 0}-${randomUUID()}`;
    try {
      await runLegacyReadOnlyChild({
        run,
        modelStack: stack,
        onAgentStart: options.onAgentStart,
        prompt: planningPrompt(request, current),
        systemPrompt: slot.systemPrompt,
        appendSystemPrompts: slot.appendSystemPrompts,
        role: "architect",
        runId: planningRunId,
        childId,
        taskId: `planning.${request.stage}`,
        description: `${request.phase} ${request.changeName}: ${request.stage}`,
        assignee: slot.id,
        thinking: slot.thinking,
        sessionDir: resolve(options.cwd, ".fusion", "runs", planningRunId, "sessions", childId),
        cwd: options.cwd,
        timeoutMs: PLANNING_TIMEOUT_MS,
        signal: options.signal,
      });
    } finally {
      await recordChangeUsage(usageStore, options.changeName, [
        usageFromLegacyRun(planningRunId, "planning", run, `planning.${request.stage}`),
      ]);
    }
    if (!runOk(run)) {
      throw new HarnessError("PLANNING_AGENT_FAILED", `Planning agent failed: ${runError(run)}`, {
        phase: request.phase,
        stage: request.stage,
        model: slot.model,
      });
    }
    return { model: run.model, content: run.text };
  });

  const dependencies = {
    runAgent: (request: PlanningAgentRequest) => runAgent(request, status, slotForRequest(stack, request)),
    async writeArtifacts(request: PlanningArtifactWriteRequest) {
      const bundle = parseArtifactBundle(request.synthesis.content);
      const seen = new Set<string>();
      const prepared = bundle.artifacts.map((artifact) => {
        const path = artifact.path.replaceAll("\\", "/");
        if (seen.has(path)) {
          throw new HarnessError("PLANNING_ARTIFACT_INVALID", `Planning synthesis duplicated ${path}`, { path });
        }
        seen.add(path);
        return { ...artifact, destination: allowedArtifactPath(changeRoot, path) };
      });
      for (const required of ["proposal.md", "design.md", "tasks.md"]) {
        if (!seen.has(required)) {
          throw new HarnessError("PLANNING_ARTIFACT_INVALID", `Planning synthesis omitted ${required}`, { required });
        }
      }
      if (![...seen].some((path) => path.startsWith("specs/") && path.endsWith("/spec.md"))) {
        throw new HarnessError("PLANNING_ARTIFACT_INVALID", "Planning synthesis omitted capability specifications");
      }
      for (const artifact of prepared) {
        await mkdir(resolve(artifact.destination, ".."), { recursive: true });
        await writeFile(
          artifact.destination,
          artifact.content.endsWith("\n") ? artifact.content : `${artifact.content}\n`,
          "utf8",
        );
      }
    },
  };

  const complexity = classifyChange({
    affectedFiles: Object.values(status.artifactPaths).flatMap((artifact) => artifact.existingOutputPaths),
    affectedCapabilities: Object.values(status.artifactPaths)
      .flatMap((artifact) => artifact.existingOutputPaths)
      .filter((path) => path.includes(`${sep}specs${sep}`)),
    hasPublicContractChange: Object.keys(status.artifactPaths).includes("specs"),
    hasDataMigration: /\bmigrat(?:e|ion)\b/i.test(options.prompt),
    hasSecurityBoundaryChange: /\b(?:security|permission|auth)\b/i.test(options.prompt),
    hasDesignAmbiguity: options.phase === "refine" && /\b(?:ambiguous|trade-?off|uncertain)\b/i.test(options.prompt),
  });
  const input = {
    changeName: options.changeName,
    prompt: options.prompt || `${options.phase} ${options.changeName}`,
    complexity,
    optionalBudgetAvailable: true,
    authoritativeContext: { status, changeRoot },
  };
  const result = options.phase === "propose"
    ? await propose(input, dependencies)
    : await refine(input, dependencies);
  return {
    status: "success",
    action: options.phase,
    changeName: options.changeName,
    runId: planningRunId,
    summary: `${options.phase} completed with ${result.policy.classification} orchestration; OpenSpec artifacts were written.`,
    next: `/change review ${options.changeName}`,
  };
}
