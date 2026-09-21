/**
 * Whether a repository-relative path is inside a declared scope: `**` is everything, `dir/**` is
 * the directory and everything under it, and anything else names one file.
 */
export function scopeMatches(path: string, scope: string): boolean {
  const normalized = scope.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (normalized === "**") return true;
  if (normalized.endsWith("/**")) {
    const root = normalized.slice(0, -3);
    return path === root || path.startsWith(`${root}/`);
  }
  return path === normalized;
}
