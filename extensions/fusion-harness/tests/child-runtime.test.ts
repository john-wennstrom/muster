import { describe, expect, test } from "bun:test";
import { resolveChildRuntime } from "../modules/runtime.ts";
import { synthesizeLegacyStack, type ModelSlot, type ModelStack } from "../modules/model-stack.ts";

function stackWithChildConfig(): { stack: ModelStack; architect: ModelSlot; main: ModelSlot } {
  const stack = synthesizeLegacyStack({
    architectModel: "anthropic/claude-fable-5",
    builderModel: "openai/gpt-5.6-sol",
    architectThinking: "high",
    builderThinking: "medium",
  });
  stack.child = {
    extensions: ["npm:semantic-tools", "/abs/memory.ts"],
    tools: {
      read: ["semantic_find", "memory_recall"],
      write: ["memory_store"],
    },
  };
  return { stack, architect: stack.architect, main: stack.primaryBuilder };
}

describe("child runtime resolution", () => {
  test("legacy stack without child config keeps base tool behavior", () => {
    const stack = synthesizeLegacyStack({
      architectModel: "anthropic/claude-fable-5",
      builderModel: "openai/gpt-5.6-sol",
      architectThinking: "high",
      builderThinking: "medium",
    });
    const read = resolveChildRuntime(stack, stack.architect, "read");
    const write = resolveChildRuntime(stack, stack.primaryBuilder, "write");
    const validator = resolveChildRuntime(stack, stack.architect, "validator");
    const none = resolveChildRuntime(stack, stack.architect, "none");

    expect(read.extensions).toEqual([]);
    expect(read.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(write.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
    expect(validator.tools).toEqual(["read", "grep", "find", "ls", "write"]);
    expect(none).toEqual({ extensions: [], tools: [] });
  });

  test("access modes include configured read/write tools correctly", () => {
    const { stack, architect } = stackWithChildConfig();
    const read = resolveChildRuntime(stack, architect, "read");
    const write = resolveChildRuntime(stack, architect, "write");
    const validator = resolveChildRuntime(stack, architect, "validator");

    expect(read.extensions).toEqual(["npm:semantic-tools", "/abs/memory.ts"]);
    expect(read.tools).toEqual(["read", "grep", "find", "ls", "semantic_find", "memory_recall"]);
    expect(write.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "semantic_find", "memory_recall", "memory_store"]);
    expect(validator.tools).toEqual(["read", "grep", "find", "ls", "write", "semantic_find", "memory_recall"]);
    expect(validator.tools.includes("memory_store")).toBe(false);
  });

  test("per-slot field overrides replace matching global fields", () => {
    const { stack, main } = stackWithChildConfig();
    main.child = {
      extensions: [],
      tools: {
        read: ["slot_read"],
      },
    };

    const read = resolveChildRuntime(stack, main, "read");
    const write = resolveChildRuntime(stack, main, "write");

    expect(read.extensions).toEqual([]);
    expect(read.tools).toEqual(["read", "grep", "find", "ls", "slot_read"]);
    expect(write.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "slot_read", "memory_store"]);
  });

  test("access none never loads extensions or tools", () => {
    const { stack, main } = stackWithChildConfig();
    expect(resolveChildRuntime(stack, main, "none")).toEqual({ extensions: [], tools: [] });
  });

  test("per-slot rule can inherit global tools and include additional ones", () => {
    const { stack, architect } = stackWithChildConfig();
    architect.child = {
      tools: {
        read: {
          include: ["arch_research"],
        },
        write: {
          include: ["arch_memory_store"],
        },
      },
    };

    const read = resolveChildRuntime(stack, architect, "read");
    const write = resolveChildRuntime(stack, architect, "write");

    expect(read.tools).toEqual(["read", "grep", "find", "ls", "semantic_find", "memory_recall", "arch_research"]);
    expect(write.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
      "semantic_find",
      "memory_recall",
      "arch_research",
      "memory_store",
      "arch_memory_store",
    ]);
  });

  test("per-slot rule can exclude inherited tools for constrained builders", () => {
    const { stack, main } = stackWithChildConfig();
    main.child = {
      tools: {
        read: {
          exclude: ["semantic_find"],
        },
        write: {
          inherit: false,
          include: [],
        },
      },
    };

    const read = resolveChildRuntime(stack, main, "read");
    const write = resolveChildRuntime(stack, main, "write");

    expect(read.tools).toEqual(["read", "grep", "find", "ls", "memory_recall"]);
    expect(write.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "memory_recall"]);
  });
});
