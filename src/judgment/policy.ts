import type { JudgmentUnavailableReason } from "./client.ts";

export type JudgmentMode = "shadow" | "enforce";

export type JudgmentEnvironment = Readonly<Record<string, string | undefined>>;

export type JudgmentPolicy =
  | { readonly enabled: true; readonly mode: JudgmentMode; readonly apiKey: string }
  | {
      readonly enabled: false;
      readonly reason: Extract<
        JudgmentUnavailableReason,
        "disabled" | "not_configured" | "invalid_configuration"
      >;
      readonly detail?: string;
    };

export const JUDGMENT_ENABLE_VARIABLE = "MUSTER_JEV";
export const JUDGMENT_API_KEY_VARIABLE = "MUSTER_JEV_API_KEY";
export const JUDGMENT_MODE_VARIABLE = "MUSTER_JEV_MODE";

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * Pure function of an environment object. Content leaves the machine only when both the
 * enabling flag and an API key are present, and once they are, decisions act (enforce) unless
 * the operator selects shadow; an unrecognized mode is unavailable rather than guessed, because
 * it must neither send content nor change behavior.
 */
export function resolveJudgmentPolicy(env: JudgmentEnvironment): JudgmentPolicy {
  if (env[JUDGMENT_ENABLE_VARIABLE]?.trim() !== "1") return { enabled: false, reason: "disabled" };
  const apiKey = env[JUDGMENT_API_KEY_VARIABLE];
  if (!present(apiKey)) return { enabled: false, reason: "not_configured" };

  const rawMode = env[JUDGMENT_MODE_VARIABLE];
  const mode = present(rawMode) ? rawMode.trim() : "enforce";
  if (mode !== "shadow" && mode !== "enforce") {
    return {
      enabled: false,
      reason: "invalid_configuration",
      detail: `${JUDGMENT_MODE_VARIABLE} must be "shadow" or "enforce"`,
    };
  }

  return { enabled: true, mode, apiKey: apiKey.trim() };
}
