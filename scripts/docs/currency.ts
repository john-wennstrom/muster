/**
 * Documentation currency: checks that documentation names everything the code has. Each function
 * takes the documents' text and the names the code declares, and returns what is missing, so a
 * test can run it against a document with a name removed.
 */

/** The ids in the first column of the security model's call-site table. */
export function securityTableDecisions(securityMarkdown: string): string[] {
  const start = securityMarkdown.indexOf("### Egress by call site");
  if (start === -1) return [];
  const afterHeading = securityMarkdown.indexOf("\n", start) + 1;
  const rest = securityMarkdown.slice(afterHeading);
  const next = rest.search(/^#{1,3} /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  return [...section.matchAll(/^\|\s*`([A-Za-z0-9_.]+)`/gm)].map((match) => match[1]!);
}

/** Every catalogued decision without a row in the security model's call-site table. */
export function decisionsWithoutSecurityRow(securityMarkdown: string, decisionIds: readonly string[]): string[] {
  const rows = new Set(securityTableDecisions(securityMarkdown));
  return decisionIds.filter((id) => !rows.has(id));
}

export interface CommandFlowGaps {
  actions: string[];
  decisions: string[];
}

/** The actions and decisions the command flow document never mentions. */
export function commandFlowGaps(
  flowMarkdown: string,
  actions: readonly string[],
  decisionIds: readonly string[],
): CommandFlowGaps {
  return {
    actions: actions.filter((action) => !flowMarkdown.includes(`/change ${action}`)),
    decisions: decisionIds.filter((id) => !flowMarkdown.includes(id)),
  };
}

/** The failures of both checks, one sentence each, naming what is missing. */
export function documentationCurrencyFailures(input: {
  securityMarkdown: string;
  flowMarkdown: string;
  actions: readonly string[];
  decisionIds: readonly string[];
}): string[] {
  const failures: string[] = [];
  const noRow = decisionsWithoutSecurityRow(input.securityMarkdown, input.decisionIds);
  if (noRow.length > 0) {
    failures.push(`docs/security.md has no call-site row for decision(s): ${noRow.join(", ")}`);
  }
  const gaps = commandFlowGaps(input.flowMarkdown, input.actions, input.decisionIds);
  if (gaps.actions.length > 0) {
    failures.push(`docs/command-flow.md does not mention action(s): ${gaps.actions.map((action) => `/change ${action}`).join(", ")}`);
  }
  if (gaps.decisions.length > 0) {
    failures.push(`docs/command-flow.md does not mention decision(s): ${gaps.decisions.join(", ")}`);
  }
  return failures;
}
