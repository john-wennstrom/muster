/**
 * child-config.ts — parses the `child` section of a model-stack file: the extensions and the tool
 * rules a spawned child gets, globally or per slot. Every problem is appended to `errors` so a
 * config reports all its mistakes at once.
 */

import * as path from "node:path";
import type { ChildConfig, ChildToolConfig, ChildToolRule } from "./model-stack.ts";

function parseChildExtensions(raw: unknown, configDir: string, label: string, errors: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${label}.extensions must be an array of extension sources`);
    return undefined;
  }
  const extensions: string[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (typeof entry !== "string") {
      errors.push(`${label}.extensions[${index}] must be a string`);
      continue;
    }
    const normalized = normalizeExtensionSource(entry.trim(), configDir);
    if (!normalized) {
      errors.push(`${label}.extensions[${index}] must not be empty`);
      continue;
    }
    extensions.push(normalized);
  }
  return extensions;
}

function parseChildTools(raw: unknown, label: string, errors: string[]): ChildToolConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${label}.tools must be a mapping`);
    return undefined;
  }
  const toolsValue = raw as Record<string, unknown>;
  const allowedToolKeys = new Set(["read", "write"]);
  for (const key of Object.keys(toolsValue)) {
    if (!allowedToolKeys.has(key)) errors.push(`${label}.tools contains unknown key ${JSON.stringify(key)}`);
  }
  const read = parseToolEntry(toolsValue.read, `${label}.tools.read`, errors);
  const write = parseToolEntry(toolsValue.write, `${label}.tools.write`, errors);
  if (read === undefined && write === undefined) return undefined;

  const readList = explicitIncludes(read);
  const writeList = explicitIncludes(write);
  for (const name of readList) {
    if (writeList.includes(name)) errors.push(`${label}.tools declares ${JSON.stringify(name)} as both read and write`);
  }

  const tools: ChildToolConfig = {};
  if (read !== undefined) tools.read = read;
  if (write !== undefined) tools.write = write;
  return tools;
}

function parseToolEntry(raw: unknown, label: string, errors: string[]): string[] | ChildToolRule | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return parseToolList(raw, label, errors);
  if (!raw || typeof raw !== "object") {
    errors.push(`${label} must be an array of tool names or a mapping with include/exclude`);
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const allowedKeys = new Set(["inherit", "include", "exclude"]);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) errors.push(`${label} contains unknown key ${JSON.stringify(key)}`);

  let inherit: boolean | undefined;
  if (value.inherit !== undefined) {
    if (typeof value.inherit !== "boolean") errors.push(`${label}.inherit must be boolean`);
    else inherit = value.inherit;
  }
  const include = parseToolList(value.include, `${label}.include`, errors);
  const exclude = parseToolList(value.exclude, `${label}.exclude`, errors);
  if (include === undefined && exclude === undefined && inherit === undefined) {
    errors.push(`${label} object must set at least one of inherit/include/exclude`);
    return undefined;
  }

  const includeList = include ?? [];
  const excludeList = exclude ?? [];
  for (const name of includeList) {
    if (excludeList.includes(name)) errors.push(`${label} includes and excludes ${JSON.stringify(name)}`);
  }

  const rule: ChildToolRule = {};
  if (inherit !== undefined) rule.inherit = inherit;
  if (include !== undefined) rule.include = include;
  if (exclude !== undefined) rule.exclude = exclude;
  return rule;
}

function explicitIncludes(value: string[] | ChildToolRule | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value.include ?? [];
}

export function parseChildConfig(raw: unknown, configDir: string, label: string, errors: string[]): ChildConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${label} must be a mapping`);
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const allowedKeys = new Set(["extensions", "tools"]);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) errors.push(`${label} contains unknown key ${JSON.stringify(key)}`);

  const extensions = parseChildExtensions(value.extensions, configDir, label, errors);
  const tools = parseChildTools(value.tools, label, errors);

  const config: ChildConfig = {};
  if (extensions !== undefined) config.extensions = extensions;
  if (tools !== undefined) config.tools = tools;
  return config;
}

function normalizeExtensionSource(source: string, configDir: string): string {
  if (!source) return "";
  if (source.startsWith("npm:") || source.startsWith("git:")) return source;
  if (path.isAbsolute(source)) return source;
  if (source.startsWith("./") || source.startsWith("../")) return path.resolve(configDir, source);
  return source;
}

function parseToolList(raw: unknown, label: string, errors: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${label} must be an array of tool names`);
    return undefined;
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (typeof entry !== "string") {
      errors.push(`${label}[${index}] must be a string`);
      continue;
    }
    const name = entry.trim();
    if (!name) {
      errors.push(`${label}[${index}] must not be empty`);
      continue;
    }
    if (name.includes(",")) {
      errors.push(`${label}[${index}] must not contain commas`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`${label} contains duplicate tool name ${JSON.stringify(name)}`);
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}
