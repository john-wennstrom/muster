import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  changeCommandDescription,
  changeResumeUsage,
  changeUsage,
  renderChangeStatus,
} from "../../src/runtime/change-command.ts";
import { HOST_EXECUTION_SECURITY_NOTICE } from "../../src/tools/command-profile.ts";

const root = resolve(import.meta.dir, "../..");
const docsDirectory = resolve(root, "docs");
const packagePath = resolve(root, "package.json");
const requiredSecurityWording = [
  "brokered and audited",
  "do not provide operating-system process or network isolation",
] as const;

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  }));
  return nested.flat();
}

function displayPath(path: string): string {
  return relative(root, path).split(sep).join("/");
}

function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const anchor = match[1]!
      .toLocaleLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    anchors.add(anchor);
  }
  return anchors;
}

async function validateLinks(path: string, markdown: string): Promise<number> {
  let count = 0;
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const destination = match[1]!.replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:)/i.test(destination)) continue;
    count++;
    const [rawTarget, rawFragment] = destination.split("#", 2);
    const target = rawTarget ? resolve(dirname(path), decodeURIComponent(rawTarget)) : path;
    const pathFromRoot = relative(root, target);
    assertCondition(
      pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`),
      `${displayPath(path)} links outside the repository: ${destination}`,
    );
    let targetSource: string;
    try {
      assertCondition((await stat(target)).isFile(), `${displayPath(path)} link is not a file: ${destination}`);
      targetSource = await readFile(target, "utf8");
    } catch (error) {
      throw new Error(`${displayPath(path)} has a broken link: ${destination}`, { cause: error });
    }
    if (rawFragment) {
      const fragment = decodeURIComponent(rawFragment).toLocaleLowerCase();
      assertCondition(
        headingAnchors(targetSource).has(fragment),
        `${displayPath(path)} has a broken heading link: ${destination}`,
      );
    }
  }
  return count;
}

function validateFences(path: string, markdown: string): string[] {
  const examples: string[] = [];
  let fence: { marker: string; language: string; lines: string[] } | null = null;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const marker = line.match(/^(`{3,}|~{3,})([^\s]*)\s*$/);
    if (!fence && marker) {
      assertCondition(marker[2], `${displayPath(path)}:${index + 1} code fence needs a language`);
      fence = { marker: marker[1]!, language: marker[2]!, lines: [] };
      continue;
    }
    if (fence && line === fence.marker) {
      if (["bash", "console", "sh", "text"].includes(fence.language)) {
        examples.push(...fence.lines);
      }
      fence = null;
      continue;
    }
    fence?.lines.push(line);
  }
  assertCondition(!fence, `${displayPath(path)} has an unclosed code fence`);
  return examples;
}

function validateCommandExamples(
  path: string,
  lines: readonly string[],
  scripts: Readonly<Record<string, string>>,
): number {
  let count = 0;
  for (const rawLine of lines) {
    const line = rawLine.replace(/^\$\s+/, "").trim();
    if (!line || line.startsWith("#") || !line.startsWith("bun ")) continue;
    count++;
    const script = line.match(/^bun run ([^\s]+)/)?.[1];
    if (script) {
      assertCondition(scripts[script], `${displayPath(path)} references missing package script: ${script}`);
      continue;
    }
    assertCondition(
      /^bun (?:install|test)(?:\s|$)/.test(line),
      `${displayPath(path)} has an unsupported Bun example: ${line}`,
    );
  }
  return count;
}

function validateSecuritySurface(label: string, content: string): void {
  for (const wording of requiredSecurityWording) {
    assertCondition(content.includes(wording), `${label} must state that beta ${wording}`);
  }
  assertCondition(!/\bsandboxed\b/i.test(content), `${label} must not claim host execution is sandboxed`);
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
  scripts?: Record<string, string>;
};
const scripts = packageJson.scripts ?? {};
assertCondition(
  scripts["docs:check"] === "bun run scripts/docs/check.ts",
  "package script docs:check must run scripts/docs/check.ts",
);

const requiredFiles = [
  resolve(root, "README.md"),
  resolve(docsDirectory, "security.md"),
  resolve(docsDirectory, "roadmap.md"),
  resolve(docsDirectory, "testing.md"),
];
const discoveredFiles = [resolve(root, "README.md"), ...await markdownFiles(docsDirectory)];
for (const requiredFile of requiredFiles) {
  assertCondition(discoveredFiles.includes(requiredFile), `missing required documentation: ${displayPath(requiredFile)}`);
}

let linkCount = 0;
let exampleCount = 0;
const sources = new Map<string, string>();
for (const path of discoveredFiles) {
  const source = await readFile(path, "utf8");
  sources.set(path, source);
  linkCount += await validateLinks(path, source);
  exampleCount += validateCommandExamples(path, validateFences(path, source), scripts);
}

validateSecuritySurface("README.md", sources.get(resolve(root, "README.md"))!);
validateSecuritySurface("docs/security.md", sources.get(resolve(docsDirectory, "security.md"))!);
validateSecuritySurface("/change help", changeUsage);
validateSecuritySurface("/change resume help", changeResumeUsage);
validateSecuritySurface("/change registration help", changeCommandDescription);
validateSecuritySurface("/change status", renderChangeStatus({
  changeName: "docs-check",
  lifecycle: "READY",
  capturedAt: "2026-09-12T00:00:00.000Z",
  observations: { openSpec: "2026-09-12T00:00:00.000Z", repository: "2026-09-12T00:00:00.000Z" },
  digests: { artifact: "a", source: "b", head: "c", index: "d", diff: "e" },
  freshness: { review: "current", validation: "missing" },
  taskStates: {},
  pendingCheckpointIds: [],
  discrepancies: [],
}));

const roadmap = sources.get(resolve(docsDirectory, "roadmap.md"))!;
assertCondition(roadmap.includes("non-blocking post-beta hardening backlog"), "roadmap must keep isolation non-blocking and post-beta");
assertCondition(roadmap.includes("behind the command-runner interface"), "roadmap must keep isolation behind the command-runner interface");

console.log(`Documentation check passed: ${discoveredFiles.length} files, ${linkCount} links, ${exampleCount} command examples.`);
