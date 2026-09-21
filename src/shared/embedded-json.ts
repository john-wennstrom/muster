/** Every top-level JSON object embedded in free text, in order; malformed candidates are skipped. */
export function embeddedJsonObjects(content: string): unknown[] {
  const objects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(content.slice(start, index + 1)));
        } catch {
          // Ignore malformed candidates; the caller reports one structured parse error.
        }
        start = -1;
      }
    }
  }
  return objects;
}
