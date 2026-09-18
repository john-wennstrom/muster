import { isAbsolute, relative, sep } from "node:path";

/** True when `candidate` is `parent` itself or nested beneath it. */
export function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
