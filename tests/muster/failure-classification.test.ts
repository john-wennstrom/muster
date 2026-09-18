import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerChangeCommand, type ChangeCommandDependencies } from "../../src/change/change-command.ts";
import {
  UNRECOGNIZED_FAILURE,
  classifyFailure,
  failureClassifications,
  failureCodeOf,
  isHarnessErrorCode,
} from "../../src/change/failure-classification.ts";
import type { MusterChangeDetails } from "../../src/change/branding.ts";
import { HarnessError, type HarnessErrorCode } from "../../src/shared/errors.ts";

const codes = Object.keys(failureClassifications) as HarnessErrorCode[];

function harness(thrown: unknown) {
  const messages: { content: string; details?: MusterChangeDetails }[] = [];
  let handler!: (args: string, context: ExtensionCommandContext) => Promise<void>;
  const dependencies: ChangeCommandDependencies = {
    resolveChangeName: async () => "add-search",
    loadSnapshot: async () => { throw thrown; },
    handlers: {},
  };
  registerChangeCommand({
    registerCommand(_name, command) { handler = command.handler; },
    sendMessage(message) {
      messages.push({ content: String(message.content), details: message.details as MusterChangeDetails });
    },
  } as Pick<ExtensionAPI, "registerCommand" | "sendMessage">, dependencies);
  return {
    messages,
    run: () => handler("implement add-search", { ui: { notify() {} } } as unknown as ExtensionCommandContext),
  };
}

describe("failure classification", () => {
  test("covers every declared error code exactly once", () => {
    expect(codes.length).toBeGreaterThan(40);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(isHarnessErrorCode(code)).toBe(true);
    }
  });

  test("every declared code converts to the status and blocker its classification declares", async () => {
    for (const code of codes) {
      const subject = harness(new HarnessError(code, `raised ${code}`));
      await subject.run();

      const declared = classifyFailure(code);
      const details = subject.messages.at(-1)?.details;
      const expectedStatus = declared.cancelled ? "cancelled" : declared.blocker ? "blocked" : "failure";

      expect({ code, status: details?.status }).toEqual({ code, status: expectedStatus });
      expect({ code, reported: details?.code }).toEqual({ code, reported: code });
    }
  });

  test("a blocking failure reports its declared artifact", async () => {
    const subject = harness(new HarnessError("VERIFICATION_ARTIFACT_INVALID", "bad artifact"));
    await subject.run();
    expect(subject.messages.at(-1)?.content).toContain("blocked");
    expect(classifyFailure("VERIFICATION_ARTIFACT_INVALID").artifact).toBe("verification.md");
  });

  test("a pending-checkpoint failure directs the user to resume from a checkpoint", async () => {
    const subject = harness(
      new HarnessError("MANUAL_CHECKPOINT_MISMATCH", "checkpoint mismatch", { checkpointId: "cp-7" }),
    );
    await subject.run();
    expect(subject.messages.at(-1)?.content).toContain("/change resume add-search <checkpoint-id>");
  });

  test("a missing change directs the user to propose it", async () => {
    const subject = harness(new HarnessError("CHANGE_NOT_FOUND", "no such change"));
    await subject.run();
    expect(subject.messages.at(-1)?.content).toContain("/change propose add-search");
  });

  test("an undeclared error reports the reserved unrecognized code", async () => {
    const subject = harness(new Error("dependency exploded"));
    await subject.run();
    expect(subject.messages.at(-1)?.details?.code).toBe(UNRECOGNIZED_FAILURE);
    expect(subject.messages.at(-1)?.details?.status).toBe("failure");
  });

  test("an error carrying an unknown code string is not reported verbatim", () => {
    expect(failureCodeOf({ code: "NOT_A_DECLARED_CODE" })).toBe(UNRECOGNIZED_FAILURE);
    expect(failureCodeOf({ code: 42 })).toBe(UNRECOGNIZED_FAILURE);
    expect(failureCodeOf(new HarnessError("WORKTREE_UNSAFE", "x"))).toBe("WORKTREE_UNSAFE");
  });

  test("host abort reports cancelled rather than a failure", async () => {
    const subject = harness(new DOMException("aborted", "AbortError"));
    await subject.run();
    expect(subject.messages.at(-1)?.details?.status).toBe("cancelled");
  });

  test("raised cancellation reports cancelled rather than a failure", async () => {
    const subject = harness(new HarnessError("PROCESS_CANCELLED", "user cancelled"));
    await subject.run();
    expect(subject.messages.at(-1)?.details?.status).toBe("cancelled");
  });
});
