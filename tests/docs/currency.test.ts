import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { changeCommands } from "../../src/change/commands.ts";
import { judgmentCatalog } from "../../src/judgment/catalog.ts";
import {
  commandFlowGaps,
  decisionsWithoutSecurityRow,
  documentationCurrencyFailures,
  securityTableDecisions,
} from "../../scripts/docs/currency.ts";

const ROOT = resolve(import.meta.dir, "../..");
const actions = Object.keys(changeCommands);
const decisionIds = judgmentCatalog.map((decision) => decision.id);

const security = (rows: readonly string[]) => [
  "# Security",
  "",
  "### Egress by call site",
  "",
  "| Decision | Also requires | State sent | Declared source paths |",
  "| --- | --- | --- | --- |",
  ...rows.map((id) => `| \`${id}\` (${id}) | Nothing | A state | None |`),
  "",
  "## Next section",
  "",
  "| `unrelated.decision` | a table after the call-site table |",
].join("\n");

const flow = (mentioning: readonly string[]) => mentioning.join("\n");

describe("the security model's call-site table", () => {
  test("a complete table passes", () => {
    expect(decisionsWithoutSecurityRow(security(decisionIds), decisionIds)).toEqual([]);
  });

  test("a decision without a row fails, naming it", () => {
    const missing = decisionIds[0]!;
    const table = security(decisionIds.filter((id) => id !== missing));
    expect(decisionsWithoutSecurityRow(table, decisionIds)).toEqual([missing]);
    expect(documentationCurrencyFailures({ securityMarkdown: table, flowMarkdown: flow([...actions.map((a) => `/change ${a}`), ...decisionIds]), actions, decisionIds }))
      .toEqual([`docs/security.md has no call-site row for decision(s): ${missing}`]);
  });

  test("only the call-site table counts", () => {
    expect(securityTableDecisions(security(["a.b"]))).toEqual(["a.b"]);
    expect(decisionsWithoutSecurityRow(security([]), ["unrelated.decision"])).toEqual(["unrelated.decision"]);
  });

  test("a document with no call-site table has no rows", () => {
    expect(securityTableDecisions("# Security\n")).toEqual([]);
  });
});

describe("the command flow document", () => {
  const complete = flow([...actions.map((action) => `/change ${action}`), ...decisionIds]);

  test("a complete document passes", () => {
    expect(commandFlowGaps(complete, actions, decisionIds)).toEqual({ actions: [], decisions: [] });
  });

  test("a missing action fails, naming it", () => {
    const without = complete.replace("/change finish", "");
    expect(commandFlowGaps(without, actions, decisionIds).actions).toEqual(["finish"]);
    expect(documentationCurrencyFailures({ securityMarkdown: security(decisionIds), flowMarkdown: without, actions, decisionIds }))
      .toEqual(["docs/command-flow.md does not mention action(s): /change finish"]);
  });

  test("a missing decision fails, naming it", () => {
    const missing = decisionIds.at(-1)!;
    const without = complete.replaceAll(missing, "");
    expect(commandFlowGaps(without, actions, decisionIds).decisions).toEqual([missing]);
    expect(documentationCurrencyFailures({ securityMarkdown: security(decisionIds), flowMarkdown: without, actions, decisionIds }))
      .toEqual([`docs/command-flow.md does not mention decision(s): ${missing}`]);
  });
});

describe("the repository's own documents", () => {
  test("name every action and decision", async () => {
    const [securityMarkdown, flowMarkdown] = await Promise.all([
      readFile(resolve(ROOT, "docs", "security.md"), "utf8"),
      readFile(resolve(ROOT, "docs", "command-flow.md"), "utf8"),
    ]);
    expect(documentationCurrencyFailures({ securityMarkdown, flowMarkdown, actions, decisionIds })).toEqual([]);
  });
});
