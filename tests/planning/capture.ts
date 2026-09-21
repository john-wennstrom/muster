/** Regenerates tests/planning/golden from the sample plans: bun run tests/planning/capture.ts */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { renderArtifacts } from "../../src/planning/render.ts";
import { samplePlan, sampleSmallPlan } from "./sample-plan.ts";

const golden = resolve(import.meta.dir, "golden");
await rm(golden, { recursive: true, force: true });
for (const [name, plan] of [["full", samplePlan()], ["small", sampleSmallPlan()]] as const) {
  const root = resolve("/change", name);
  for (const artifact of renderArtifacts(plan, root)) {
    const target = resolve(golden, name, relative(root, artifact.path));
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, artifact.content);
  }
}
console.log("Golden artifacts written to tests/planning/golden");
