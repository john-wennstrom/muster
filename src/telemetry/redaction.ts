import { z } from "zod";

const maximumDiagnosticLength = 240;

export const telemetryDiagnosticCategorySchema = z.enum([
  "authentication",
  "elevated_permission",
  "destructive",
  "external_side_effect",
  "design_decision",
  "budget",
  "failure",
  "retry",
]);

export const telemetryDiagnosticInputSchema = z.object({
  phase: z.enum(["planning", "implementation", "validation"]),
  category: telemetryDiagnosticCategorySchema,
  detail: z.string().min(1).max(8_192),
  secretValues: z.array(z.string().min(1).max(8_192)).max(100).optional(),
}).strict();

export type TelemetryDiagnosticInput = z.input<typeof telemetryDiagnosticInputSchema>;
export type TelemetryDiagnosticCategory = z.infer<typeof telemetryDiagnosticCategorySchema>;

function redactSecretPatterns(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-\r\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+ PRIVATE KEY-----/gi,
      "[REDACTED]",
    )
    .replace(
      /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:--?)(?:password|passphrase|token|api[-_]?key|secret)(?:=|\s+))(?:(?:"[^"]*")|(?:'[^']*')|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:password|passphrase|token|api[-_]?key|secret|_authToken)\b\s*[:=]\s*)(?:(?:"[^"]*")|(?:'[^']*')|[^\s,;&]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:password|passphrase|token|api[-_]?key|secret)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    );
}

export function sanitizeTelemetryText(
  value: string,
  secretValues: readonly string[] = [],
): string {
  let sanitized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  for (const secret of secretValues) {
    if (secret) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  sanitized = redactSecretPatterns(sanitized).replace(/\s+/g, " ").trim();
  if (!sanitized) return "[REDACTED]";
  if (sanitized.length <= maximumDiagnosticLength) return sanitized;
  return `${sanitized.slice(0, maximumDiagnosticLength - 3).trimEnd()}...`;
}

export function sanitizeTelemetryDiagnostic(input: unknown): Readonly<{
  phase: "planning" | "implementation" | "validation";
  category: TelemetryDiagnosticCategory;
  detail: string;
}> {
  const parsed = telemetryDiagnosticInputSchema.parse(input);
  return Object.freeze({
    phase: parsed.phase,
    category: parsed.category,
    detail: sanitizeTelemetryText(parsed.detail, parsed.secretValues),
  });
}