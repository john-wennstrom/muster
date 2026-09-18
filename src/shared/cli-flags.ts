/** Reads `--flag value` / `--flag=value` directly from argv, as fusion-harness does before pi resolves registered flags. */
export function readCliFlag(name: string, argv: readonly string[]): string {
  const long = `--${name}`;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === long) return argv[index + 1]?.trim() ?? "";
    if (argv[index]!.startsWith(`${long}=`)) return argv[index]!.slice(long.length + 1).trim();
  }
  return "";
}
