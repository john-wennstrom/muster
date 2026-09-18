import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createCommandRunContext,
  resolveProductionChange,
  validateChangeSlug,
} from "../../src/runtime/command.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function planningHome(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "muster-command-runtime-"));
  roots.push(root);
  await mkdir(resolve(root, "openspec", "changes"), { recursive: true });
  return root;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof HarnessError ? error.code : undefined;
}

describe("command run context", () => {
  test("preserves invocation identity, cancellation, models, and output", () => {
    const abort = new AbortController();
    const output = { write: () => undefined };
    const context = createCommandRunContext({
      action: "review",
      repositoryCwd: "C:\\repo-b",
      planningHome: "C:\\repo-b",
      models: { reviewer: "openai/reviewer" },
      signal: abort.signal,
      output,
    });

    expect(context.repositoryCwd).toBe(resolve("C:\\repo-b"));
    expect(context.planningHome).toBe(resolve("C:\\repo-b"));
    expect(context.models.reviewer).toBe("openai/reviewer");
    expect(context.signal).toBe(abort.signal);
    expect(context.output).toBe(output);
    expect(Object.isFrozen(context)).toBe(true);
  });
});

describe("production change resolution", () => {
  test.each(["../escape", "a/b", "a\\b", ".", "UPPER", "two--dashes", "has space"])(
    "rejects invalid slug %s",
    (value) => {
      expect(() => validateChangeSlug(value)).toThrow(HarnessError);
    },
  );

  test("rejects absolute paths before filesystem lookup", () => {
    expect(() => validateChangeSlug(resolve("absolute-change"))).toThrow(HarnessError);
  });

  test("resolves an existing canonical directory inside the planning home", async () => {
    const root = await planningHome();
    await mkdir(resolve(root, "openspec", "changes", "add-search"));
    const change = await resolveProductionChange({ planningHome: root, changeName: "add-search" });
    expect(change.name).toBe("add-search");
    expect(change.exists).toBe(true);
    expect(change.changeRoot).toBe(await realpath(resolve(root, "openspec", "changes", "add-search")));
  });

  test("reports a missing existing change but permits a proposal target", async () => {
    const root = await planningHome();
    let missingError: unknown;
    try {
      await resolveProductionChange({ planningHome: root, changeName: "missing" });
    } catch (error) {
      missingError = error;
    }
    expect(errorCode(missingError)).toBe("CHANGE_NOT_FOUND");
    const proposed = await resolveProductionChange({
      planningHome: root,
      changeName: "missing",
      allowMissing: true,
    });
    expect(proposed.exists).toBe(false);
  });

  test("rejects a case-normalization collision", async () => {
    const root = await planningHome();
    await mkdir(resolve(root, "openspec", "changes", "Add-Search"));
    let collisionError: unknown;
    try {
      await resolveProductionChange({ planningHome: root, changeName: "add-search" });
    } catch (error) {
      collisionError = error;
    }
    expect(errorCode(collisionError)).toBe("CHANGE_SLUG_COLLISION");
  });
});
