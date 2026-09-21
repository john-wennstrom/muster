import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { renderAgentPrompts, renderQuestionGoldens } from "./samples.ts";

const golden = resolve(import.meta.dir, "golden");

async function stored(directory: string, extension: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of await readdir(resolve(golden, directory))) {
    if (name.endsWith(`.${extension}`)) {
      found[name.slice(0, -extension.length - 1)] = await readFile(resolve(golden, directory, name), "utf8");
    }
  }
  return found;
}

describe("rendered agent prompts", () => {
  test("every agent prompt matches its golden byte for byte", async () => {
    const expected = await stored("agents", "txt");
    const rendered = renderAgentPrompts();
    expect(Object.keys(rendered).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, text] of Object.entries(rendered)) {
      expect(text, `agent prompt ${name}`).toBe(expected[name]!);
    }
  });
});

describe("judgment questions", () => {
  test("every decision's questions match their golden canonical form", async () => {
    const expected = await stored("judgment", "json");
    const rendered = renderQuestionGoldens();
    expect(Object.keys(rendered).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, canonical] of Object.entries(rendered)) {
      expect(canonical, `questions for ${name}`).toBe(expected[name]!);
    }
  });
});
