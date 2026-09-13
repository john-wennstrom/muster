import { resolve } from "node:path";
import { runProcess } from "../../src/shared/process.ts";

const root = resolve(import.meta.dir, "../..");
const workflow = "cross-platform.yml";
const expectedRunners = ["ubuntu-latest", "macos-latest", "windows-latest"] as const;

async function command(executable: string, args: readonly string[]): Promise<string> {
  const result = await runProcess(executable, args, { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

const head = await command("git", ["rev-parse", "HEAD"]);
const runs = JSON.parse(await command("gh", [
  "run",
  "list",
  "--workflow",
  workflow,
  "--commit",
  head,
  "--limit",
  "1",
  "--json",
  "databaseId,status,conclusion,url",
])) as Array<{
  databaseId: number;
  status: string;
  conclusion: string;
  url: string;
}>;

const run = runs[0];
if (!run) {
  throw new Error(
    `No ${workflow} run exists for HEAD ${head}. Review and trigger the workflow externally, then retry.`,
  );
}
if (run.status !== "completed" || run.conclusion !== "success") {
  throw new Error(
    `Cross-platform CI is ${run.status}/${run.conclusion || "pending"}: ${run.url}`,
  );
}

const details = JSON.parse(await command("gh", [
  "run",
  "view",
  String(run.databaseId),
  "--json",
  "jobs",
])) as {
  jobs: Array<{ name: string; status: string; conclusion: string; url: string }>;
};

for (const runner of expectedRunners) {
  const job = details.jobs.find((candidate) => candidate.name.startsWith(`${runner} /`));
  if (!job) throw new Error(`Cross-platform CI run is missing the ${runner} job: ${run.url}`);
  if (job.status !== "completed" || job.conclusion !== "success") {
    throw new Error(`${runner} job is ${job.status}/${job.conclusion || "pending"}: ${job.url}`);
  }
}

console.log(`Cross-platform CI passed for ${expectedRunners.join(", ")}: ${run.url}`);