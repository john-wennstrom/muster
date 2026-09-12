import type { Code, Heading, List, ListItem, Nodes, Paragraph, Root } from "mdast";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { parse as parseYaml } from "yaml";
import { HarnessError } from "../shared/errors.ts";

export interface SourcePoint {
  line: number;
  column: number;
  offset?: number;
}

export interface SourceRange {
  start: SourcePoint;
  end: SourcePoint;
}

export interface ParsedTask {
  checkboxId: string;
  description: string;
  checked: boolean;
  phase: number;
  phaseTitle: string;
  metadata: Readonly<Record<string, unknown>>;
  location: {
    path: string;
    checkbox: SourceRange;
    metadata: SourceRange;
  };
}

export interface ParsedTaskPhase {
  number: number;
  title: string;
  tasks: ParsedTask[];
  location: SourceRange;
}

export interface ParsedTaskDocument {
  phases: ParsedTaskPhase[];
  tasks: ParsedTask[];
}

function invalid(
  message: string,
  path: string,
  node?: { position?: Nodes["position"] },
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): never {
  throw new HarnessError(
    "TASK_DOCUMENT_INVALID",
    `${message}: ${path}${node?.position?.start ? `:${node.position.start.line}:${node.position.start.column}` : ""}`,
    {
      path,
      location: node?.position,
      ...details,
    },
    cause === undefined ? undefined : { cause },
  );
}

function sourceRange(node: { position?: Nodes["position"] }, path: string): SourceRange {
  if (!node.position) return invalid("Markdown node has no source location", path, node);
  return {
    start: { ...node.position.start },
    end: { ...node.position.end },
  };
}

function textContent(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map((child) => textContent(child as Nodes)).join("");
  }
  return "";
}

function parsePhaseHeading(heading: Heading): { number: number; title: string } | undefined {
  if (heading.depth !== 2) return undefined;
  const text = textContent(heading).trim();
  const match = text.match(/^(?:Phase\s+)?(\d+)(?:\.\s+|\s*[-—:]\s*)(.*)$/i);
  if (!match) return undefined;
  return {
    number: Number(match[1]),
    title: match[2]!.trim() || `Phase ${match[1]}`,
  };
}

function isHarnessMetadata(node: Nodes): node is Code {
  return node.type === "code" && node.lang?.toLowerCase() === "yaml" && node.meta?.trim() === "harness-task";
}

function parseMetadata(node: Code, path: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = parseYaml(node.value);
  } catch (cause) {
    return invalid("Task metadata is not valid YAML", path, node, {}, cause);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Task metadata must be a YAML mapping", path, node);
  }
  return Object.freeze({ ...(value as Record<string, unknown>) });
}

function parseTaskItem(
  item: ListItem,
  phase: ParsedTaskPhase,
  path: string,
): ParsedTask | undefined {
  if (item.checked === null || item.checked === undefined) return undefined;
  const paragraph = item.children[0];
  if (!paragraph || paragraph.type !== "paragraph") {
    return invalid("Executable checkbox must begin with a task description", path, item);
  }
  const taskText = textContent(paragraph as Paragraph).trim();
  const taskMatch = taskText.match(/^([0-9]+(?:\.[0-9A-Za-z_-]+)*)\s+(.+)$/);
  if (!taskMatch) {
    return invalid("Executable checkbox must begin with a task identifier", path, paragraph);
  }

  const metadataNodes = item.children.filter((child): child is Code => isHarnessMetadata(child));
  if (metadataNodes.length !== 1) {
    return invalid("Executable checkbox must contain exactly one yaml harness-task block", path, item, {
      checkboxId: taskMatch[1],
      metadataBlocks: metadataNodes.length,
    });
  }
  const metadataNode = metadataNodes[0]!;
  if (item.children.length !== 2 || item.children[1] !== metadataNode) {
    return invalid("yaml harness-task block must be immediately adjacent to its checkbox description", path, metadataNode, {
      checkboxId: taskMatch[1],
    });
  }

  return {
    checkboxId: taskMatch[1]!,
    description: taskMatch[2]!.trim(),
    checked: item.checked,
    phase: phase.number,
    phaseTitle: phase.title,
    metadata: parseMetadata(metadataNode, path),
    location: {
      path,
      checkbox: sourceRange(item, path),
      metadata: sourceRange(metadataNode, path),
    },
  };
}

function parseTaskList(list: List, phase: ParsedTaskPhase, path: string): ParsedTask[] {
  return list.children.flatMap((item) => {
    const task = parseTaskItem(item, phase, path);
    return task ? [task] : [];
  });
}

export function parseTaskDocument(contents: string, path: string): ParsedTaskDocument {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(contents) as Root;
  const phases: ParsedTaskPhase[] = [];
  const tasks: ParsedTask[] = [];
  let phase: ParsedTaskPhase | undefined;

  for (const node of tree.children) {
    if (node.type === "heading") {
      const heading = parsePhaseHeading(node);
      if (!heading) continue;
      if (phases.some((candidate) => candidate.number === heading.number)) {
        return invalid("Task document contains a duplicate phase number", path, node, {
          phase: heading.number,
        });
      }
      phase = {
        ...heading,
        tasks: [],
        location: sourceRange(node, path),
      };
      phases.push(phase);
      continue;
    }
    if (node.type !== "list") continue;
    const executableItems = node.children.filter((item) => item.checked !== null && item.checked !== undefined);
    if (executableItems.length === 0) continue;
    if (!phase) return invalid("Executable checkbox appears before a phase heading", path, node);
    const parsed = parseTaskList(node, phase, path);
    phase.tasks.push(...parsed);
    tasks.push(...parsed);
  }

  return { phases, tasks };
}