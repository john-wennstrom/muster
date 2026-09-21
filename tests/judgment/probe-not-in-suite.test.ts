import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runProcess } from "../../src/shared/process.ts";

const root = resolve(import.meta.dir, "../..");

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("judgment probe", () => {
  test("the suite never imports or runs the probe", () => {
    for (const path of [...files(resolve(root, "tests")), ...files(resolve(root, "src"))]) {
      if (path === import.meta.path) continue;
      expect(readFileSync(path, "utf8"), path).not.toContain("judgment/probe");
    }
  });

  test("the probe is reachable through a package script", () => {
    const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts as Record<string, string>;
    expect(scripts["judgment:probe"]).toBe("bun run scripts/judgment/probe.ts");
  });

  test("without configuration the probe explains itself and sends nothing", async () => {
    const result = await runProcess("bun", ["run", "scripts/judgment/probe.ts"], {
      cwd: root,
      env: { ...process.env, MUSTER_JEV: "", MUSTER_JEV_API_KEY: "" },
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Judgment is not configured");
  });
});
