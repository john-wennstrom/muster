import type { JsonValue, JudgmentQuestions } from "./client.ts";

/**
 * Everything that decides what may leave the machine: redaction of every string in a state,
 * a denylist over the repository paths a call site says contributed to the state, and size
 * limits. Redaction is best-effort; the denylist and size checks refuse rather than repair.
 *
 * The existing redactors are deliberately not reused: the checkpoint redactor lives in the
 * controller layer (which a later change makes depend on this layer), omits private keys and
 * URL secrets, and the telemetry redactor collapses whitespace and truncates, which is wrong
 * for a state.
 */

export const REDACTED = "[REDACTED]";

/** Service limits: 32k for the state plus the longest question, 64k for everything. */
export const JUDGMENT_QUESTION_TOKEN_LIMIT = 32_000;
export const JUDGMENT_REQUEST_TOKEN_LIMIT = 64_000;

const secretName = "(?:password|passphrase|token|api[-_]?key|secret|_authToken)";
const quotedOrBare = `(?:"[^"]*"|'[^']*'|[^\\s,;&"']+)`;

const redactionPatterns: readonly (readonly [RegExp, string])[] = [
  [
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi,
    REDACTED,
  ],
  [/(authorization\s*:\s*(?:bearer|basic|token)\s+)[^\s,;]+/gi, `$1${REDACTED}`],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  [
    new RegExp(`((?:--?)${secretName.replace("|_authToken", "")}(?:=|\\s+))${quotedOrBare}`, "gi"),
    `$1${REDACTED}`,
  ],
  [
    new RegExp(`(\\b[\\w.-]*${secretName}\\b["']?\\s*[:=]\\s*)${quotedOrBare}`, "gi"),
    `$1${REDACTED}`,
  ],
  [
    /([?&](?:[\w.-]*(?:password|passphrase|token|api[-_]?key|secret|signature)|key|sig|auth)=)[^&#\s"']+/gi,
    `$1${REDACTED}`,
  ],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi, `$1${REDACTED}`],
];

const secretKeyName = new RegExp(`^[\\w.-]*${secretName}$`, "i");

export function redactString(value: string, secretValues: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secretValues) {
    if (secret) redacted = redacted.replaceAll(secret, REDACTED);
  }
  for (const [pattern, replacement] of redactionPatterns) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/** Redacts every string in a state; a string held under a secret-named key is replaced whole. */
export function redactState(state: JsonValue, secretValues: readonly string[] = []): JsonValue {
  if (typeof state === "string") return redactString(state, secretValues);
  if (Array.isArray(state)) return state.map((item) => redactState(item, secretValues));
  if (state && typeof state === "object") {
    return Object.fromEntries(
      Object.entries(state as { readonly [key: string]: JsonValue }).map(([key, value]) => [
        key,
        typeof value === "string" && secretKeyName.test(key)
          ? REDACTED
          : redactState(value, secretValues),
      ]),
    );
  }
  return state;
}

export type DeniedPathFamily = "environment" | "private_key" | "registry_auth" | "cloud_credentials";

const denylist: readonly (readonly [DeniedPathFamily, RegExp])[] = [
  ["environment", /(^|\/)\.env(\..*)?$/],
  ["environment", /(^|\/)[^/]*\.env$/],
  ["private_key", /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|gpg|ppk)$/],
  ["private_key", /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/],
  ["registry_auth", /(^|\/)\.(npmrc|yarnrc|yarnrc\.yml|pypirc|netrc|_netrc)$/],
  ["registry_auth", /(^|\/)\.gem\/credentials$/],
  ["registry_auth", /(^|\/)\.cargo\/credentials(\.toml)?$/],
  ["cloud_credentials", /(^|\/)\.aws\/(credentials|config)$/],
  ["cloud_credentials", /(^|\/)\.config\/gcloud\//],
  ["cloud_credentials", /(^|\/)application_default_credentials\.json$/],
  ["cloud_credentials", /(^|\/)service[-_]?account[^/]*\.json$/],
  ["cloud_credentials", /(^|\/)\.azure\//],
  ["cloud_credentials", /(^|\/)\.kube\/config$/],
  ["cloud_credentials", /(^|\/)\.docker\/config\.json$/],
  ["cloud_credentials", /(^|\/)\.git-credentials$/],
  ["cloud_credentials", /(^|\/)\.config\/gh\/hosts\.yml$/],
  ["cloud_credentials", /(^|\/)credentials\.json$/],
];

export interface DeniedPath {
  readonly path: string;
  readonly family: DeniedPathFamily;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(\.\/)+/, "").toLowerCase();
}

/** Returns every declared path that names credential-bearing content. */
export function deniedPaths(paths: readonly string[]): readonly DeniedPath[] {
  const denied: DeniedPath[] = [];
  for (const path of paths) {
    const normalized = normalizePath(path);
    const match = denylist.find(([, pattern]) => pattern.test(normalized));
    if (match) denied.push({ path, family: match[0] });
  }
  return denied;
}

/** Deliberately over-estimates (three bytes per token) so limits are refused early, never late. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

export type EgressCheck =
  | {
      readonly ok: true;
      /** The redacted state, exactly as it will be sent: never truncated. */
      readonly state: JsonValue;
      readonly stateText: string;
      readonly estimatedTokens: number;
    }
  | {
      readonly ok: false;
      readonly reason: "state_denied" | "state_too_large";
      readonly detail: string;
    };

export interface EgressInput {
  readonly state: JsonValue;
  readonly questions: JudgmentQuestions;
  /** Every repository path whose content contributes to the state. */
  readonly sourcePaths?: readonly string[];
  /** Exact values (such as the API key) that must never appear, on top of the patterns. */
  readonly secretValues?: readonly string[];
}

export function prepareEgress(input: EgressInput): EgressCheck {
  const denied = deniedPaths(input.sourcePaths ?? []);
  if (denied.length > 0) {
    return {
      ok: false,
      reason: "state_denied",
      detail: denied.map(({ path, family }) => `${path} (${family})`).join(", "),
    };
  }

  const state = redactState(input.state, input.secretValues);
  const stateText = typeof state === "string" ? state : JSON.stringify(state);
  const stateTokens = estimateTokens(stateText);
  const questionTokens = Object.values(input.questions).map((question) =>
    estimateTokens(JSON.stringify(question)));
  const longest = Math.max(0, ...questionTokens);
  const total = questionTokens.reduce((sum, tokens) => sum + tokens, 0);

  if (stateTokens + longest > JUDGMENT_QUESTION_TOKEN_LIMIT) {
    return {
      ok: false,
      reason: "state_too_large",
      detail: `state plus longest question is about ${stateTokens + longest} tokens (limit ${JUDGMENT_QUESTION_TOKEN_LIMIT})`,
    };
  }
  if (stateTokens + total > JUDGMENT_REQUEST_TOKEN_LIMIT) {
    return {
      ok: false,
      reason: "state_too_large",
      detail: `state plus all questions is about ${stateTokens + total} tokens (limit ${JUDGMENT_REQUEST_TOKEN_LIMIT})`,
    };
  }
  return { ok: true, state, stateText, estimatedTokens: stateTokens + total };
}
