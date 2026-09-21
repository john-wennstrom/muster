import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createPromptRenderer, isRenderedPrompt, PROMPTS_ROOT } from "../../src/prompts/render.ts";

const renderer = createPromptRenderer(resolve(import.meta.dir, "fixtures/agents"));

const originalDirectory = process.cwd();
afterEach(() => process.chdir(originalDirectory));

describe("prompt renderer", () => {
  test("substitutes declared variables verbatim", () => {
    const text = String(renderer.render("greeting", { NAME: "Ada {{X}}\n\n\n\nend", OPTIONAL_NOTE: "See below." }));
    expect(text).toBe("Hello Ada {{X}}\n\n\n\nend.\n\nSee below.\n\nGoodbye.");
  });

  test("a missing variable fails naming the template and the variable", () => {
    expect(() => renderer.render("greeting", { NAME: "Ada" })).toThrow(/greeting.*variable OPTIONAL_NOTE was not supplied/);
  });

  test("an unknown variable fails naming the template and the variable", () => {
    expect(() => renderer.render("greeting", { NAME: "Ada", OPTIONAL_NOTE: "", EXTRA: "x" }))
      .toThrow(/greeting.*variable EXTRA is not declared/);
  });

  test("a placeholder the front matter does not declare fails when the template loads", () => {
    expect(() => renderer.render("undeclared", { NAME: "Ada" })).toThrow(/undeclared.*undeclared placeholder \{\{OTHER\}\}/);
  });

  test("a declared variable the body never uses fails when the template loads", () => {
    expect(() => renderer.render("unused", { NAME: "Ada", EXTRA: "x" })).toThrow(/unused.*EXTRA is never used/);
  });

  test("a template without front matter fails", () => {
    expect(() => renderer.render("no-front-matter", {})).toThrow(/no-front-matter.*front matter/);
  });

  test("an empty optional block leaves no run of blank lines", () => {
    expect(String(renderer.render("greeting", { NAME: "Ada", OPTIONAL_NOTE: "" }))).toBe("Hello Ada.\n\nGoodbye.");
  });

  test("an empty placeholder alone on its line takes its line break with it", () => {
    expect(String(renderer.render("lines", { FIRST: "", SECOND: "two", INLINE: "" }))).toBe("Header\ntwo\nTail");
    expect(String(renderer.render("lines", { FIRST: "one", SECOND: "", INLINE: "x" }))).toBe("Header\none\nTail x");
    expect(String(renderer.render("lines", { FIRST: "", SECOND: "", INLINE: "" }))).toBe("Header\nTail");
  });

  test("a missing template file names the file", () => {
    expect(() => renderer.render("absent")).toThrow(/absent.*absent\.md cannot be read/);
  });

  test("only renderer output is a rendered prompt", () => {
    const text = renderer.render("greeting", { NAME: "Ada", OPTIONAL_NOTE: "" });
    expect(isRenderedPrompt(text)).toBeTrue();
    expect(isRenderedPrompt("Hello Ada.\n\nGoodbye. ")).toBeFalse();
    expect(isRenderedPrompt(42)).toBeFalse();
  });

  test("the prompts directory does not depend on the working directory", () => {
    const before = PROMPTS_ROOT;
    process.chdir("/tmp");
    expect(PROMPTS_ROOT).toBe(before);
    expect(before).toBe(resolve(import.meta.dir, "../../prompts"));
  });
});
