import { runProcess } from "../src/shared/process.ts";

function providerArgument(args: readonly string[]): string {
  const index = args.indexOf("--provider");
  const provider = index === -1 ? undefined : args[index + 1];
  if (!provider || index + 2 !== args.length) {
    throw new Error("Usage: bun run doctor -- --provider <provider>");
  }
  return provider;
}

async function pi(args: readonly string[]) {
  return runProcess("pi", args, { cwd: process.cwd(), timeoutMs: 30_000 });
}

const provider = providerArgument(process.argv.slice(2));
const auth = await pi(["auth", "check", "--provider", provider, "--json", "--no-refresh"]);
let readiness: { status?: string; provider?: string; reason?: string };
try {
  readiness = JSON.parse(auth.stdout) as typeof readiness;
} catch {
  throw new Error(`Pi returned invalid readiness data for ${provider}`);
}
if (auth.exitCode !== 0 || readiness.provider !== provider || readiness.status !== "ready") {
  throw new Error(
    `${provider} provider is not ready: ${readiness.reason ?? `pi exited ${auth.exitCode}`}`,
  );
}

const models = await pi(["--list-models", provider]);
if (models.exitCode !== 0) {
  throw new Error(`Pi model discovery failed for ${provider}: ${models.stderr.trim()}`);
}
const availableModels = models.stdout.split(/\r?\n/).filter((line) =>
  line.trimStart().startsWith(`${provider} `)
);
if (availableModels.length === 0) {
  throw new Error(`${provider} is authenticated but no exact-provider model is available`);
}

console.log(`${provider} provider is ready with ${availableModels.length} available model(s).`);