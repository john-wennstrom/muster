import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ensureFusionDrivenSchemaInstalled,
  fusionDrivenSchemaSource,
  openSpecUserSchemasDir,
} from "../../src/openspec/fusion-driven-schema.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), prefix));
  directories.push(path);
  return path;
}

describe("fusion-driven schema install", () => {
  test("copies muster's canonical schema, including the harness-task tasks template", async () => {
    const destinationDir = await tempDir("muster-schema-dest-");

    const installedPath = await ensureFusionDrivenSchemaInstalled({ destinationDir });

    expect(installedPath).toBe(resolve(destinationDir, "fusion-driven"));
    const schemaYaml = await readFile(resolve(installedPath, "schema.yaml"), "utf8");
    expect(schemaYaml).toContain("name: fusion-driven");
    const tasksTemplate = await readFile(resolve(installedPath, "templates", "tasks.md"), "utf8");
    expect(tasksTemplate).toContain("```yaml harness-task");
  });

  test("is idempotent — re-running overwrites rather than merging stale files", async () => {
    const destinationDir = await tempDir("muster-schema-dest-");

    await ensureFusionDrivenSchemaInstalled({ destinationDir });
    const secondInstall = await ensureFusionDrivenSchemaInstalled({ destinationDir });

    const tasksTemplate = await readFile(resolve(secondInstall, "templates", "tasks.md"), "utf8");
    expect(tasksTemplate).toContain("```yaml harness-task");
  });

  test("reports a HarnessError when the source schema cannot be read", async () => {
    const destinationDir = await tempDir("muster-schema-dest-");

    await expect(ensureFusionDrivenSchemaInstalled({
      source: resolve(destinationDir, "does-not-exist"),
      destinationDir,
    })).rejects.toMatchObject({ code: "OPENSPEC_SCHEMA_INSTALL_FAILED" } satisfies Partial<HarnessError>);
  });

  test("resolves muster's own schema source directory", () => {
    expect(fusionDrivenSchemaSource().endsWith(resolve("schemas", "fusion-driven"))).toBeTrue();
  });

  test("resolves OpenSpec's XDG user-schema directory", () => {
    expect(openSpecUserSchemasDir({ XDG_DATA_HOME: "/xdg-data" })).toBe(resolve("/xdg-data", "openspec", "schemas"));
    expect(openSpecUserSchemasDir({}).endsWith(join(".local", "share", "openspec", "schemas"))).toBeTrue();
  });
});
