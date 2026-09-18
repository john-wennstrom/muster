import { userInfo } from "node:os";

export const FALLBACK_ACTOR = "local-user";

/** Identifies the human confirming an action: `MUSTER_ACTOR` override, else the OS user. */
export function resolveActor(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MUSTER_ACTOR?.trim();
  if (override) return override;
  try {
    return userInfo().username.trim() || FALLBACK_ACTOR;
  } catch {
    return FALLBACK_ACTOR;
  }
}
