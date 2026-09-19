import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  extractTerms,
  MAX_CANDIDATES,
  MAX_EXCERPT_BYTES,
  MAX_FILE_BYTES,
  retrieveCandidates,
  truncateBytes,
} from "../../src/context/candidates.ts";
import { runProcess } from "../../src/shared/process.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function repository(files: Record<string, string | Buffer>, options: { ignore?: string } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-candidates-"));
  roots.push(root);
  await git(root, "init");
  await git(root, "config", "user.email", "muster@example.invalid");
  await git(root, "config", "user.name", "Muster Tests");
  if (options.ignore) await writeFile(resolve(root, ".gitignore"), options.ignore);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), contents);
  }
  await git(root, "add", "-f", ".");
  await git(root, "commit", "-m", "fixture");
  return root;
}

const REQUEST = "Make `parseInvoice` retry when the invoice_total is missing";

describe("term extraction", () => {
  test("finds quoted, camel-case, snake-case, kebab-case, and path terms in request order", () => {
    expect(extractTerms(
      "Rename `loadConfig` in src/config/loader.ts so retry_limit and the fetch-window are honored",
    )).toEqual(["loadConfig", "src/config/loader.ts", "retry_limit", "fetch-window"]);
  });

  test("drops common words and duplicates and caps the count", () => {
    expect(extractTerms("`the` `and` `parseInvoice` parseInvoice")).toEqual(["parseInvoice"]);
    const many = Array.from({ length: 30 }, (_, index) => `helperNumber${String.fromCharCode(97 + (index % 26))}${index}`);
    expect(extractTerms(many.join(" ")).length).toBe(12);
  });

  test("a request with no identifiers yields nothing", () => {
    expect(extractTerms("make it better")).toEqual([]);
  });
});

describe("candidate retrieval", () => {
  test("returns matching files ranked by distinct terms, then path, with matched terms and excerpts", async () => {
    const root = await repository({
      "src/invoice.ts": "export function parseInvoice(input) {\n  return input.invoice_total;\n}\n",
      "src/other.ts": "// mentions parseInvoice only\n",
      "src/a-first.ts": "// mentions invoice_total only\n",
      "src/unrelated.ts": "export const x = 1;\n",
    });
    const candidates = await retrieveCandidates({ cwd: root, request: REQUEST });
    expect(candidates.map(({ path }) => path)).toEqual(["src/invoice.ts", "src/a-first.ts", "src/other.ts"]);
    expect(candidates[0]).toEqual({
      path: "src/invoice.ts",
      matchedTerms: ["parseInvoice", "invoice_total"],
      excerpt: "1: export function parseInvoice(input) {\n2: return input.invoice_total;",
    });
  });

  test("is deterministic across runs", async () => {
    const root = await repository(Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [`src/f${index}.ts`, "parseInvoice\n"]),
    ));
    const first = await retrieveCandidates({ cwd: root, request: REQUEST });
    const second = await retrieveCandidates({ cwd: root, request: REQUEST });
    expect(second).toEqual(first);
    expect(first.map(({ path }) => path)).toEqual(
      Array.from({ length: 15 }, (_, index) => `src/f${index}.ts`).sort().slice(0, MAX_CANDIDATES),
    );
  });

  test("returns at most ten candidates, each with an excerpt of at most 600 bytes", async () => {
    const long = `${"parseInvoice ".repeat(400)}\n`.repeat(20) + "é".repeat(500);
    const root = await repository(Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [`src/f${index}.ts`, long]),
    ));
    const candidates = await retrieveCandidates({ cwd: root, request: REQUEST });
    expect(candidates).toHaveLength(MAX_CANDIDATES);
    for (const candidate of candidates) {
      expect(Buffer.byteLength(candidate.excerpt, "utf8")).toBeLessThanOrEqual(MAX_EXCERPT_BYTES);
      expect(candidate.excerpt.length).toBeGreaterThan(0);
    }
  });

  test("never returns an ignored, binary, oversized, dependency-directory, or environment file", async () => {
    const root = await repository({
      "src/keep.ts": "parseInvoice\n",
      "src/binary.bin": Buffer.from("parseInvoice\0\0"),
      "src/huge.txt": `parseInvoice${" ".repeat(MAX_FILE_BYTES)}`,
      "node_modules/dep/index.js": "parseInvoice\n",
      "sub/node_modules/dep.js": "parseInvoice\n",
      ".env": "parseInvoice=1\n",
      "config/prod.env": "parseInvoice=1\n",
      "keys/server.pem": "parseInvoice\n",
      ".fusion/runs/log.txt": "parseInvoice\n",
    }, { ignore: "ignored/\n" });
    await writeFile(resolve(root, "untracked.ts"), "parseInvoice\n");
    await mkdir(resolve(root, "ignored"));
    await writeFile(resolve(root, "ignored/untracked-ignored.ts"), "parseInvoice\n");
    const candidates = await retrieveCandidates({ cwd: root, request: REQUEST });
    expect(candidates.map(({ path }) => path)).toEqual(["src/keep.ts", "untracked.ts"]);
  });

  test("does not follow a symlink out of the repository", async () => {
    const outside = await mkdtemp(resolve(tmpdir(), "muster-candidates-outside-"));
    roots.push(outside);
    await writeFile(resolve(outside, "secret.txt"), "parseInvoice\n");
    const root = await repository({ "src/keep.ts": "parseInvoice\n" });
    await symlink(resolve(outside, "secret.txt"), resolve(root, "link.txt"));
    await git(root, "add", "link.txt");
    expect((await retrieveCandidates({ cwd: root, request: REQUEST })).map(({ path }) => path))
      .toEqual(["src/keep.ts"]);
  });

  test("skips a tracked file that was deleted from the working tree", async () => {
    const root = await repository({ "src/keep.ts": "parseInvoice\n", "src/gone.ts": "parseInvoice\n" });
    await rm(resolve(root, "src/gone.ts"));
    expect((await retrieveCandidates({ cwd: root, request: REQUEST })).map(({ path }) => path))
      .toEqual(["src/keep.ts"]);
  });

  test("matches a file named in the request by its path", async () => {
    const root = await repository({ "src/config/loader.ts": "export {};\n", "src/other.ts": "export {};\n" });
    const candidates = await retrieveCandidates({ cwd: root, request: "Fix src/config/loader.ts" });
    expect(candidates).toEqual([{
      path: "src/config/loader.ts",
      matchedTerms: ["src/config/loader.ts"],
      excerpt: "1: export {};",
    }]);
  });

  test("a request without identifiers retrieves nothing", async () => {
    const root = await repository({ "src/keep.ts": "parseInvoice\n" });
    expect(await retrieveCandidates({ cwd: root, request: "make it better" })).toEqual([]);
  });

  test("stops when aborted", async () => {
    const root = await repository({ "src/keep.ts": "parseInvoice\n" });
    const controller = new AbortController();
    controller.abort();
    await expect(retrieveCandidates({ cwd: root, request: REQUEST, signal: controller.signal })).rejects.toThrow();
  });
});

describe("byte truncation", () => {
  test("never splits a multi-byte character", () => {
    expect(truncateBytes("ééé", 5)).toBe("éé");
    expect(truncateBytes("abc", 10)).toBe("abc");
    expect(truncateBytes("😀😀", 5)).toBe("😀");
  });
});
