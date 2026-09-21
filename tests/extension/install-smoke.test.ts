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
  test("discovers one extension that registers only the change command and its flags", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };

    expect(packageJson.pi?.extensions).toEqual(["./src/muster/index.ts"]);

    const extensionUrl = pathToFileURL(
      resolve(root, packageJson.pi!.extensions![0]!),
    ).href;
    const extensionModule = await import(extensionUrl);

    const commands = new Map<string, RegisteredCommand>();
    const flags = new Map<string, unknown>();
    const api = {
      getFlag: () => undefined,
      on: () => undefined,
      registerCommand: (name: string, command: RegisteredCommand) => {
        if (commands.has(name)) throw new Error(`duplicate command: ${name}`);
        commands.set(name, command);
      },
      registerFlag: (name: string, flag: unknown) => {
        if (flags.has(name)) throw new Error(`duplicate flag: ${name}`);
        flags.set(name, flag);
      },
      registerMessageRenderer: () => undefined,
    } as unknown as ExtensionAPI;

    extensionModule.default(api);

    expect([...commands.keys()]).toEqual(["change"]);
    expect([...flags.keys()].sort()).toEqual([
      "architect",
      "builder",
      "fh-config",
      "planning-max-cost",
      "planning-max-tokens",
    ]);
    expect(extensionModule.registerFusionHarness).toBeUndefined();

    const notifications: string[] = [];
    await commands.get("change")!.handler("", {
      ui: { notify: (message: string) => notifications.push(message) },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("explore");
    expect(notifications[0]).toContain("resume");
  });

  test("no retired command is registered and no migration stub exists", async () => {
    const commands = new Set<string>();
    const api = {
      getFlag: () => undefined,
      on: () => undefined,
      registerCommand: (name: string) => commands.add(name),
      registerFlag: () => undefined,
      registerMessageRenderer: () => undefined,
    } as unknown as ExtensionAPI;
    (await import(pathToFileURL(resolve(root, "src/muster/index.ts")).href)).default(api);

    for (const retired of ["refine", "implement", "ship", "os-status", "init", "fh", "fh-opinion", "fh-fusion"]) {
      expect(commands.has(retired), `/${retired} must not be registered`).toBeFalse();
    }
    expect([...commands].filter((name) => name.startsWith("fh"))).toEqual([]);
  });
});
