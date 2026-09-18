import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach } from "bun:test";
import { resolveModelStack, roleModel, roleEnvOverride } from "../../src/change/models.ts";
import { resolveExploreModel } from "../../src/change/phases/exploration.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stackConfig(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "muster-models-"));
  directories.push(root);
  const path = resolve(root, "stack.yaml");
  await writeFile(path, [
    "slots:",
    "  - name: architect",
    "    model: github-copilot/configured-architect",
    "    architect: true",
    "    thinking: high",
    "  - name: builder",
    "    model: github-copilot/configured-builder",
    "    primary: true",
    "",
  ].join("\n"), "utf8");
  return path;
}

describe("resolveModelStack", () => {
  test("nothing configured resolves each role to its single declared fallback", () => {
    const stack = resolveModelStack([], {});
    expect(roleModel(stack, "architect")).toBe("anthropic/claude-fable-5");
    expect(roleModel(stack, "builder")).toBe("openai/gpt-5.6-sol");
    expect(roleModel(stack, "validator")).toBe(roleModel(stack, "architect"));
  });

  test("a command-line flag overrides the declared fallback", () => {
    const stack = resolveModelStack(["--architect", "flag/architect", "--builder=flag/builder"], {});
    expect(roleModel(stack, "architect")).toBe("flag/architect");
    expect(roleModel(stack, "builder")).toBe("flag/builder");
  });

  test("a configured model stack supplies every role", async () => {
    const stack = resolveModelStack(["--fh-config", await stackConfig()], {});
    expect(roleModel(stack, "architect")).toBe("github-copilot/configured-architect");
    expect(roleModel(stack, "builder")).toBe("github-copilot/configured-builder");
  });

  test("an environment override wins over a configured model stack for a non-exploration role", async () => {
    const argv = ["--fh-config", await stackConfig()];
    const stack = resolveModelStack(argv, { MUSTER_BUILDER_MODEL: "env/builder" });
    expect(roleModel(stack, "builder")).toBe("env/builder");
    expect(roleModel(stack, "architect")).toBe("github-copilot/configured-architect");
  });

  test("the architect override also reaches the validator role", () => {
    const stack = resolveModelStack([], { MUSTER_ARCHITECT_MODEL: "env/architect" });
    expect(roleModel(stack, "validator")).toBe("env/architect");
  });

  test("the exploration variable remains an architect alias", () => {
    expect(roleEnvOverride("architect", { MUSTER_EXPLORE_MODEL: "env/explore" })).toBe("env/explore");
    expect(resolveExploreModel({ MUSTER_EXPLORE_MODEL: "env/explore" }, [])).toBe("env/explore");
  });

  test("exploration follows the same precedence as every other role", async () => {
    const argv = ["--fh-config", await stackConfig()];
    expect(resolveExploreModel({}, argv)).toBe("github-copilot/configured-architect");
    expect(resolveExploreModel({ MUSTER_ARCHITECT_MODEL: "env/architect" }, argv)).toBe("env/architect");
  });
});
