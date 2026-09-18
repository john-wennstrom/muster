import { describe, expect, test } from "bun:test";
import { HarnessError } from "../../src/shared/errors.ts";
import { registerChangeCommand, type ChangeCommandDependencies } from "../../src/muster/change-command.ts";

function registeredHarness(dependencies: ChangeCommandDependencies) {
  let handler: ((args: string, context: unknown) => Promise<void>) | undefined;
  const messages: string[] = [];
  registerChangeCommand({
    registerCommand(_name, command) {
      handler = command.handler as typeof handler;
    },
    sendMessage(message) {
      messages.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    },
  }, dependencies);
  return {
    messages,
    invoke: (args: string) => handler!(args, {
      cwd: process.cwd(),
      ui: { notify: () => undefined },
    }),
  };
}

describe("persistent command outcomes", () => {
  test("unexpected production failures emit one durable failure", async () => {
    const subject = registeredHarness({
      resolveChangeName: async () => "add-search",
      loadSnapshot: async () => { throw new Error("snapshot exploded"); },
      handlers: {},
    });

    await subject.invoke("status add-search");

    expect(subject.messages).toHaveLength(1);
    expect(subject.messages[0]).toContain("Status: failure");
    expect(subject.messages[0]).toContain("Code: UNEXPECTED_ERROR");
    expect(subject.messages[0]).toContain("snapshot exploded");
  });

  test("process cancellation emits one durable cancelled outcome", async () => {
    const subject = registeredHarness({
      resolveChangeName: async () => null,
      loadSnapshot: async () => null,
      handlers: {
        explore: async () => {
          throw new HarnessError("PROCESS_CANCELLED", "exploration cancelled");
        },
      },
    });

    await subject.invoke("explore inspect cancellation");

    expect(subject.messages).toHaveLength(1);
    expect(subject.messages[0]).toContain("Status: cancelled");
    expect(subject.messages[0]).toContain("Code: PROCESS_CANCELLED");
  });

  test("known identity and model prerequisites remain actionable blocked outcomes", async () => {
    for (const error of [
      new HarnessError("CHANGE_IDENTIFIER_INVALID", "expected a lowercase kebab-case slug"),
      Object.assign(new Error("No eligible model is available for reviewer"), { code: "MODEL_UNAVAILABLE" }),
    ]) {
      const subject = registeredHarness({
        resolveChangeName: async () => { throw error; },
        loadSnapshot: async () => null,
        handlers: {},
      });

      await subject.invoke("review add-search");

      expect(subject.messages).toHaveLength(1);
      expect(subject.messages[0]).toContain("Status: blocked");
      expect(subject.messages[0]).toContain(`Code: ${(error as { code: string }).code}`);
      expect(subject.messages[0]).toContain("Next: /change status add-search");
    }
  });
});
