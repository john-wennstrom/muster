import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface RegisteredCommand {
  description: string;
  handler: (args: string, context: unknown) => Promise<void> | void;
}

const root = resolve(import.meta.dir, "../..");

describe("muster extension installation", () => {
  test("discovers one extension that registers compatibility and change commands", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };

    expect(packageJson.pi?.extensions).toEqual(["./src/muster/index.ts"]);

    const extensionUrl = pathToFileURL(
      resolve(root, packageJson.pi!.extensions![0]!),
    ).href;
    const extensionModule = await import(extensionUrl);
    expect(extensionModule.registerFusionHarness).toBeFunction();

    const commands = new Map<string, RegisteredCommand>();
    const api = {
      getFlag: () => undefined,
      on: () => undefined,
      registerCommand: (name: string, command: RegisteredCommand) => {
        if (commands.has(name)) throw new Error(`duplicate command: ${name}`);
        commands.set(name, command);
      },
      registerFlag: () => undefined,
      registerMessageRenderer: () => undefined,
    } as unknown as ExtensionAPI;

    extensionModule.default(api);

    for (const command of [
      "change",
      "fh",
      "fh-auto-validate",
      "fh-collaborate",
      "fh-debate",
      "fh-fusion",
      "fh-model",
      "fh-only",
      "fh-opinion",
      "fh-reset",
      "fh-system-prompt",
      "implement",
      "init",
      "os-status",
      "refine",
      "ship",
    ]) {
      expect(commands.has(command), `missing /${command}`).toBeTrue();
    }

    const notifications: string[] = [];
    await commands.get("change")!.handler("", {
      ui: { notify: (message: string) => notifications.push(message) },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("explore");
    expect(notifications[0]).toContain("resume");
  });
});