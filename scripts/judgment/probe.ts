/**
 * Sends each judgment decision's representative input to the live service and prints the answers
 * by question identifier and whether the decision's gate would act. A human tool for checking
 * question wording after a change to a file under prompts/judgment; never part of the test suite.
 *
 *   MUSTER_JEV=1 MUSTER_JEV_API_KEY=... bun run judgment:probe [decision-id]
 */
import { judgmentCatalog } from "../../src/judgment/catalog.ts";
import { createFetchJudgmentClient, JUDGMENT_MODEL } from "../../src/judgment/client.ts";
import { prepareEgress } from "../../src/judgment/egress.ts";
import { resolveJudgmentPolicy } from "../../src/judgment/policy.ts";
import { validateQuestions } from "../../src/judgment/questions.ts";

const policy = resolveJudgmentPolicy(process.env);
if (!policy.enabled) {
  console.error(
    `Judgment is not configured (${policy.reason}). Set MUSTER_JEV=1 and MUSTER_JEV_API_KEY to probe the live service; ` +
      "nothing was sent.",
  );
  process.exit(2);
}

const wanted = process.argv[2];
const decisions = wanted ? judgmentCatalog.filter((decision) => decision.id === wanted) : judgmentCatalog;
if (decisions.length === 0) {
  console.error(`No decision named ${wanted}. Known decisions: ${judgmentCatalog.map((decision) => decision.id).join(", ")}`);
  process.exit(2);
}

const client = createFetchJudgmentClient({ apiKey: policy.apiKey });
let failures = 0;

for (const decision of decisions) {
  console.log(`\n== ${decision.id} v${decision.version} (model ${JUDGMENT_MODEL})`);
  const questions = validateQuestions(decision.id, decision.questions(decision.representativeInput));
  const egress = prepareEgress({
    state: decision.state(decision.representativeInput),
    questions,
    secretValues: [policy.apiKey],
  });
  if (!egress.ok) {
    console.log(`   not sent: ${egress.reason}${egress.detail ? ` (${egress.detail})` : ""}`);
    failures += 1;
    continue;
  }
  const result = await client.request({
    state: egress.state,
    questions,
    decision: { id: decision.id, version: decision.version },
  });
  if (!result.available) {
    console.log(`   unavailable: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
    failures += 1;
    continue;
  }
  for (const [id, answer] of Object.entries(result.answers)) {
    const detail = answer.type === "noul"
      ? answer.noul.toFixed(2)
      : answer.type === "choice"
        ? `${answer.choice} (confidence ${answer.confidence.toFixed(2)})`
        : `${answer.score.toFixed(2)} (confidence ${answer.confidence.toFixed(2)})`;
    console.log(`   ${id}: ${detail}`);
  }
  const outcome = decision.gate(result.answers);
  console.log(outcome.act ? `   gate: would act ${JSON.stringify(outcome.value)}` : `   gate: abstains (${outcome.reason})`);
}

process.exit(failures > 0 ? 1 : 0);
