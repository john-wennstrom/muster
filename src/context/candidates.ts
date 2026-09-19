import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GitAdapter } from "../execution/git.ts";
import { deniedPaths } from "../judgment/egress.ts";

/**
 * Candidate retrieval for planning preflight: find the repository files a request most likely
 * concerns, without a model, an index, or an external search program. The result depends only
 * on the request and the repository's eligible files, so two runs over the same state agree.
 *
 * Eligibility matches the broker's search tool: tracked and non-ignored untracked text files
 * of at most 2 MiB, excluding `.git`, `.fusion` run logs, and `node_modules`. A file the
 * credential denylist names is never a candidate, because a candidate's excerpt leaves the
 * machine.
 */

export const MAX_CANDIDATES = 10;
export const MAX_EXCERPT_BYTES = 600;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TERMS = 12;
const MAX_EXCERPT_LINES = 6;
const MAX_EXCERPT_LINE_CHARS = 160;
const READ_BATCH = 32;
const EXCLUDED_SEGMENTS = new Set([".git", ".fusion", "node_modules"]);

export interface Candidate {
  /** Repository-relative, forward slashes. */
  readonly path: string;
  /** At most 600 bytes: the first matching lines with their line numbers. */
  readonly excerpt: string;
  /** The request terms this file matched, in the order the request mentions them. */
  readonly matchedTerms: readonly string[];
}

const COMMON_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than",
  "not", "but", "are", "was", "has", "have", "add", "make", "use", "new", "all", "any",
  "should", "would", "could", "each", "every", "only", "also", "just", "some", "more",
  "true", "false", "null", "undefined", "e.g", "i.e", "etc",
]);

const trimTerm = (term: string): string => term.replace(/^[./:_-]+|[./:,;:_-]+$/g, "");

/** Explicit paths, quoted identifiers, and camel-, snake-, and kebab-case tokens, in request order. */
export function extractTerms(request: string): string[] {
  const found: { index: number; term: string }[] = [];
  const collect = (pattern: RegExp, group = 0): void => {
    for (const match of request.matchAll(pattern)) {
      const raw = match[group];
      if (raw === undefined) continue;
      found.push({ index: match.index + match[0].indexOf(raw), term: trimTerm(raw) });
    }
  };
  // Backticked, double-quoted, and single-quoted identifiers (no whitespace inside).
  collect(/`([\w./:@-]+)`/g, 1);
  collect(/"([\w./:@-]+)"/g, 1);
  collect(/(?<![\w])'([\w./:@-]+)'(?![\w])/g, 1);
  // Paths with a directory, and bare file names with an extension.
  collect(/(?<![\w./@-])(?:[\w@.-]+\/)+[\w.-]*\w/g);
  collect(/(?<![\w./@-])[\w-]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|toml|py|rs|go|java|kt|rb|sh|css|html|sql)\b/g);
  // camelCase and PascalCase with at least one internal hump, snake_case, and kebab-case.
  collect(/\b[a-z]+[a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g);
  collect(/\b(?:[A-Z][a-z0-9]+){2,}\b/g);
  collect(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g);
  collect(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g);

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const { term } of found.sort((left, right) => left.index - right.index)) {
    if (term.length < 3 || COMMON_WORDS.has(term.toLowerCase()) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

/** The longest prefix of `text` that fits in `limit` UTF-8 bytes, never splitting a character. */
export function truncateBytes(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}

function excerptFor(lines: readonly string[], terms: readonly string[]): string {
  const picked: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (terms.some((term) => line.includes(term))) {
      picked.push(`${index + 1}: ${line.trim().slice(0, MAX_EXCERPT_LINE_CHARS)}`);
      if (picked.length === MAX_EXCERPT_LINES) break;
    }
  }
  // A file matched only by its path has no matching line: show where it starts instead.
  if (picked.length === 0) {
    for (const [index, line] of lines.slice(0, MAX_EXCERPT_LINES).entries()) {
      if (line.trim()) picked.push(`${index + 1}: ${line.trim().slice(0, MAX_EXCERPT_LINE_CHARS)}`);
    }
  }
  return truncateBytes(picked.join("\n"), MAX_EXCERPT_BYTES);
}

function eligiblePath(path: string): boolean {
  if (path.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  return deniedPaths([path]).length === 0;
}

export interface RetrieveOptions {
  readonly cwd: string;
  readonly request: string;
  readonly signal?: AbortSignal;
}

/** Up to ten candidates, best first: most distinct terms matched, ties broken by path. */
export async function retrieveCandidates(options: RetrieveOptions): Promise<Candidate[]> {
  const terms = extractTerms(options.request);
  if (terms.length === 0) return [];
  const files = (await new GitAdapter(options.cwd, undefined, 30_000, options.signal).listFiles())
    .filter(eligiblePath);

  const ranked: Candidate[] = [];
  for (let offset = 0; offset < files.length; offset += READ_BATCH) {
    options.signal?.throwIfAborted();
    const batch = await Promise.all(files.slice(offset, offset + READ_BATCH).map(async (path) => {
      let contents: string;
      try {
        const location = resolve(options.cwd, path);
        // lstat, so a symlink (which could point outside the repository) is never followed.
        const stat = await lstat(location);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
        contents = await readFile(location, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Tracked but deleted, or unreadable: not a candidate.
        if (code === "ENOENT" || code === "EACCES" || code === "EISDIR") return null;
        throw error;
      }
      if (contents.includes("\0")) return null;
      const matchedTerms = terms.filter((term) => path.includes(term) || contents.includes(term));
      if (matchedTerms.length === 0) return null;
      return { path, matchedTerms, excerpt: excerptFor(contents.split(/\r?\n/), matchedTerms) };
    }));
    for (const candidate of batch) if (candidate) ranked.push(candidate);
  }

  return ranked
    .sort((left, right) =>
      right.matchedTerms.length - left.matchedTerms.length
      || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
}
