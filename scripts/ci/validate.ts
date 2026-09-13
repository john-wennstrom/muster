import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(import.meta.dir, "../..");
const workflowPath = resolve(root, ".github/workflows/cross-platform.yml");
const packagePath = resolve(root, "package.json");

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assertCondition(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function asStringRecord(value: unknown, label: string): Record<string, string> {
  const record = asRecord(value, label);
  for (const [key, entry] of Object.entries(record)) {
    assertCondition(typeof entry === "string", `${label}.${key} must be a string`);
  }
  return record as Record<string, string>;
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
const packageRecord = asRecord(packageJson, "package.json");
assertCondition(packageRecord.packageManager === "bun@1.4.0", "packageManager must pin bun@1.4.0");
const engines = asStringRecord(packageRecord.engines, "package.json engines");
assertCondition(engines.node.startsWith(">=22"), "Node.js 22 must be supported by package.json");

const requiredScripts = {
  "acceptance:ci-status": "bun run scripts/ci/status.ts",
  "ci:test": "bun test",
  "ci:validate": "bun run scripts/ci/validate.ts",
  "test:extension-smoke": "bun test tests/extension/install-smoke.test.ts",
  "test:git-worktree": "bun test tests/execution/git.test.ts tests/execution/worktree.test.ts",
  "test:host-runner": "bun test tests/tools/host-runner.test.ts tests/security/broker-host-adversarial.test.ts",
  typecheck: "tsc --noEmit",
};
const scripts = asStringRecord(packageRecord.scripts, "package.json scripts");
for (const [name, command] of Object.entries(requiredScripts)) {
  assertCondition(scripts[name] === command, `package script ${name} must be: ${command}`);
}

const workflowSource = await readFile(workflowPath, "utf8");
const workflowDocument = parseDocument(workflowSource, {
  prettyErrors: true,
  uniqueKeys: true,
});
assertCondition(
  workflowDocument.errors.length === 0,
  `workflow YAML is invalid:\n${workflowDocument.errors.map((error) => error.message).join("\n")}`,
);

const workflow = asRecord(workflowDocument.toJS(), "workflow");
const jobs = asRecord(workflow.jobs, "workflow jobs");
const job = asRecord(jobs["cross-platform"], "cross-platform job");
assertCondition(job["runs-on"] === "${{ matrix.os }}", "cross-platform job must run on matrix.os");

const strategy = asRecord(job.strategy, "cross-platform strategy");
const matrix = asRecord(strategy.matrix, "cross-platform matrix");
assertCondition(Array.isArray(matrix.os), "cross-platform matrix.os must be a sequence");
const expectedOperatingSystems = ["ubuntu-latest", "macos-latest", "windows-latest"];
assertCondition(
  JSON.stringify(matrix.os) === JSON.stringify(expectedOperatingSystems),
  `matrix.os must be ${expectedOperatingSystems.join(", ")}`,
);

assertCondition(Array.isArray(job.steps), "cross-platform job steps must be a sequence");
const steps = job.steps.map((step, index) => asRecord(step, `cross-platform step ${index + 1}`));
const nodeStep = steps.find((step) => step.uses === "actions/setup-node@v4");
assertCondition(nodeStep, "workflow must use actions/setup-node@v4");
assertCondition(asRecord(nodeStep.with, "setup-node inputs")["node-version"] === "22", "workflow must use Node.js 22");
const bunStep = steps.find((step) => step.uses === "oven-sh/setup-bun@v2");
assertCondition(bunStep, "workflow must use oven-sh/setup-bun@v2");
assertCondition(asRecord(bunStep.with, "setup-bun inputs")["bun-version"] === "1.4.0", "workflow must pin Bun 1.4.0");

const requiredCommands = [
  "bun install --frozen-lockfile",
  "bun run ci:validate",
  "bun run typecheck",
  "bun run ci:test",
  "bun run test:extension-smoke",
  "bun run test:git-worktree",
  "bun run test:host-runner",
];
const runSteps = steps.filter((step) => typeof step.run === "string");
for (const step of runSteps) {
  assertCondition(step.shell === undefined, `run step ${String(step.name)} must use the native runner shell`);
  assertCondition((step.run as string).startsWith("bun "), `run step ${String(step.name)} must invoke Bun directly`);
}
for (const command of requiredCommands) {
  assertCondition(runSteps.some((step) => step.run === command), `workflow is missing command: ${command}`);
}

console.log("Cross-platform CI workflow is valid for Linux, macOS, and native Windows.");