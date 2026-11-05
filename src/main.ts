import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { run } from "./runner.js";
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    goal: { type: "string" },
    out: { type: "string" },
    "max-calls": { type: "string", default: "24" },
    "max-actions": { type: "string", default: "200" },
    "max-probes": { type: "string", default: "5" },
    "max-journeys": { type: "string", default: "3" },
    minutes: { type: "string", default: "10" },
    headed: { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help || !values.url || !values.goal) {
  console.log(
    'npm start -- --url http://localhost:3000 --goal "Create and rename a project" [--out runs/example] [--headed] [--max-calls 24] [--max-actions 200] [--max-probes 5] [--max-journeys 3] [--minutes 10]',
  );
  process.exit(values.help ? 0 : 1);
}
const url = new URL(values.url);
if (!["http:", "https:"].includes(url.protocol))
  throw new Error("URL must use HTTP(S)");
function positive(value: string | undefined) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n))
    throw new Error("Budgets must be positive integers");
  return n;
}
const state = await run({
  url: url.href,
  goal: values.goal,
  out: resolve(
    values.out ?? `runs/${new Date().toISOString().replace(/[:.]/g, "-")}`,
  ),
  maxCalls: positive(values["max-calls"]),
  maxActions: positive(values["max-actions"]),
  maxProbes: positive(values["max-probes"]),
  maxJourneys: positive(values["max-journeys"]),
  minutes: positive(values.minutes),
  headless: !values.headed,
});
console.log(`Report: ${state.config.out}/report.html`);
if (state.error) {
  console.error(state.error);
  process.exitCode = 1;
}
