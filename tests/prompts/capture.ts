/**
 * Regenerates tests/prompts/golden. Run it when prompt or question wording changes on purpose:
 *   bun run tests/prompts/capture.ts
 * and review the diff of the golden files it rewrites. The prompt sites it covers are listed in
 * samples.ts.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderAgentPrompts, renderQuestionGoldens } from "./samples.ts";

const golden = resolve(import.meta.dir, "golden");

async function write(directory: string, extension: string, files: Record<string, string>): Promise<void> {
  const target = resolve(golden, directory);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(resolve(target, `${name}.${extension}`), content);
  }
}

await write("agents", "txt", renderAgentPrompts());
await write("judgment", "json", renderQuestionGoldens());
console.log("Golden files written to tests/prompts/golden");
