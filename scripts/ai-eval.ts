import { openRouterFromEnv, type Usage } from "../src/ai/openrouter";
import { classifyRequest, draftClientMessage, extractScope } from "../src/ai/scope-ai";
import { AGREEMENT, CASES } from "./fixtures/sample-project";

const INJECTIONS = CASES.filter((c) => c.note === "injection").length;

const models = process.argv.slice(2);
if (models.length === 0 && process.env.OPENROUTER_MODEL) models.push(process.env.OPENROUTER_MODEL);

const summary: string[] = [];

for (const modelId of models) {
  console.log(`\n=== ${modelId}`);
  const model = openRouterFromEnv(process.env, modelId);
  let cost = 0;
  let costKnown = true;
  const track = (usage: Usage) => {
    if (usage.costUsd === null) costKnown = false;
    else cost += usage.costUsd;
  };

  let passed = 0;
  let injectionFlags = 0;
  let badCitations = 0;
  let errors = 0;
  const started = Date.now();

  for (const item of CASES) {
    try {
      const { classification: c, usage } = await classifyRequest(model, item.agreement, item.message);
      track(usage);
      const pass = c.label === item.expected;
      if (pass) passed++;
      if (item.note === "injection" && c.injectionSuspected) injectionFlags++;
      badCitations += c.rejectedQuotes.length;
      console.log(
        `${pass ? "PASS" : "MISS"}  ${item.note.padEnd(24)} expected ${item.expected.padEnd(16)} got ${c.label.padEnd(16)}` +
          `${c.suggestedMinutes ? ` ${c.suggestedMinutes}m` : ""}${c.downgraded ? " (citation rejected)" : ""}${pass ? "" : `  <- ${item.message}`}`,
      );
    } catch (error) {
      errors++;
      console.log(`ERROR ${item.note}: ${error instanceof Error ? error.message : error}`);
    }
  }

  let extractLine = "not run";
  try {
    const extracted = await extractScope(model, AGREEMENT);
    track(extracted.usage);
    extractLine = `${extracted.items.length} items, ${extracted.rejected.length} rejected`;
  } catch (error) {
    errors++;
    extractLine = `failed: ${error instanceof Error ? error.message : error}`;
  }
  console.log(`extract: ${extractLine}`);

  let draftLine = "not run";
  try {
    const draft = await draftClientMessage(model, {
      freelancerName: "Asha",
      clientName: "Lumen Coffee",
      extras: ["New logo", "Online table booking"],
    });
    track(draft.usage);
    draftLine = "ok";
    console.log(`draft: ${draft.message}`);
  } catch (error) {
    errors++;
    draftLine = "failed";
    console.log(`draft failed: ${error instanceof Error ? error.message : error}`);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const costText = costKnown ? `$${cost.toFixed(5)}` : `at least $${cost.toFixed(5)}`;
  summary.push(
    `${modelId}: ${passed}/${CASES.length} labels, injection flagged ${injectionFlags}/${INJECTIONS}, ` +
      `invented quotes ${badCitations}, errors ${errors}, extract ${extractLine}, draft ${draftLine}, ${seconds}s, ${costText}`,
  );
}

console.log(`\n=== Summary\n${summary.join("\n")}`);
