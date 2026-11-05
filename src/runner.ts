import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { z } from "zod";
import {
  Candidate,
  Decision,
  Journey,
  Review,
  Verification,
  type Config,
  type Model,
  type State,
} from "./types.js";
import { createModel } from "./model.js";
import { session } from "./browser.js";

const probePrompt = `Return {kind:"probe",purpose:string,code:string} or {kind:"done",outcome:"completed"|"blocked"|"inconclusive",summary:string,candidates:[{id,title,expected,observed,steps:string[],evidenceIds:string[]}]}. Code is an async function BODY, not a function declaration. Available: await ui.observe(), ui.screenshot(), ui.press(key), ui.scroll(dy). Standard mode also has ui.click(role,name), ui.fill(role,name,text). Return a JSON-serializable result. No imports, globals, direct DOM access, timers or raw Playwright. Every UI call returns {evidenceId,value}. Use exact observed role/name. Keyboard-only: use press for all interactions; scroll is for inspection only. Limit each probe to 20 operations. Cite only supplied evidence IDs. Screenshot files are saved evidence, not images you can see. Do not claim visual judgments. Report candidates only for demonstrated barriers; failed locators alone are not app defects.`;

type AxeBaseline = {
  kind: "baseline";
  violations: Array<{
    id: string;
    impact: string | null;
    description: string;
    nodes: Array<{ target: string[]; failureSummary?: string | null }>;
  }>;
  overflow: boolean;
  errors: string[];
};

const baselineEntries = (state: State) =>
  Object.entries(state.evidence).filter(
    (entry): entry is [string, AxeBaseline] => {
      const value = entry[1];
      return Boolean(
        value &&
          typeof value === "object" &&
          (value as AxeBaseline).kind === "baseline" &&
          Array.isArray((value as AxeBaseline).violations),
      );
    },
  );

const renderAxeMarkdown = (state: State) => {
  const baselines = baselineEntries(state);
  if (!baselines.length) return "No automated accessibility baseline was recorded.";
  return baselines
    .map(
      ([id, baseline]) =>
        `Baseline evidence ${id}: ${baseline.violations.length} axe violation types; horizontal overflow: ${baseline.overflow ? "yes" : "no"}.\n\n${baseline.violations.map((violation) => `- **${violation.impact ?? "unknown"} — ${violation.id}:** ${violation.description} (${violation.nodes.length} nodes)\n${violation.nodes.map((node) => `  - ${node.target.join(" ")}${node.failureSummary ? ` — ${node.failureSummary}` : ""}`).join("\n")}`).join("\n")}`,
    )
    .join("\n\n");
};

const escapeHtml = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
      character
    ]!,
  );

function renderHtmlReport(state: State) {
  const findings = state.findings.length
    ? state.findings
        .map((finding) => {
          const candidate = state.candidates.find(
            (item) => item.id === finding.candidateId,
          );
          if (!candidate) return "";
          return `<article class="finding"><h3>${escapeHtml(finding.status)}: ${escapeHtml(candidate.title)}</h3><dl><dt>Expected</dt><dd>${escapeHtml(candidate.expected)}</dd><dt>Observed</dt><dd>${escapeHtml(candidate.observed)}</dd><dt>Assessment</dt><dd>${escapeHtml(finding.reason)}</dd></dl><h4>Steps</h4><ol>${candidate.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol><p>Evidence: ${escapeHtml([...candidate.evidenceIds, ...finding.evidenceIds].join(", "))}</p></article>`;
        })
        .join("")
    : "<p>No agent findings. This does not establish accessibility or complete coverage.</p>";
  const coverage = state.coverage
    .map((item) => `<tr><td>${escapeHtml(item.pass)}</td><td>${escapeHtml(item.journey.goal)}</td><td>${escapeHtml(item.journey.mode)}</td><td>${escapeHtml(item.outcome)}</td><td>${escapeHtml(item.summary)}</td></tr>`)
    .join("");
  const axe = baselineEntries(state)
    .map(
      ([id, baseline]) => `<article><h3>Baseline (${escapeHtml(id)})</h3><p>${baseline.violations.length} axe violation types; horizontal overflow: ${baseline.overflow ? "yes" : "no"}.</p>${baseline.violations.length ? `<ul>${baseline.violations.map((violation) => `<li><strong>${escapeHtml(violation.impact ?? "unknown")} — ${escapeHtml(violation.id)}</strong>: ${escapeHtml(violation.description)} (${violation.nodes.length} nodes)<ul>${violation.nodes.map((node) => `<li><code>${escapeHtml(node.target.join(" "))}</code>${node.failureSummary ? `<p>${escapeHtml(node.failureSummary)}</p>` : ""}</li>`).join("")}</ul></li>`).join("")}</ul>` : "<p>No axe violations detected.</p>"}</article>`,
    )
    .join("");
  const sessions = [
    ...new Set(
      Object.keys(state.evidence)
        .map((id) => id.match(/^(session-\d+)-/)?.[1])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const traces = sessions
    .map((session) => `<li><a href="evidence/${session}-trace.zip">${session} Playwright trace</a></li>`)
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JourneyLens report</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;color:#20242b}h1,h2{line-height:1.2}.status{padding:12px 16px;border-radius:8px;background:${state.error ? "#fff0e8" : "#eaf7ee"}}article,section{margin:24px 0;padding:20px;border:1px solid #d9dee7;border-radius:10px}dt{font-weight:700}dd{margin:0 0 12px}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #d9dee7}pre{overflow:auto;background:#f4f6f8;padding:16px;border-radius:8px}a{color:#0759bd}</style><body><h1>JourneyLens report</h1><p><strong>Goal:</strong> ${escapeHtml(state.config.goal)}</p><p class="status">${state.error ? `Run incomplete: ${escapeHtml(state.error)}` : "Run completed."}</p><section><h2>Findings</h2>${findings}</section><section><h2>Automated accessibility baseline</h2><p>These are automated baseline results and may differ from the fully rendered page.</p>${axe || "<p>No automated accessibility baseline was recorded.</p>"}</section><section><h2>Coverage</h2><table><thead><tr><th>Pass</th><th>Journey</th><th>Mode</th><th>Outcome</th><th>Summary</th></tr></thead><tbody>${coverage}</tbody></table></section><section><h2>Playwright traces</h2><ul>${traces}</ul><p>Open a trace with <code>npx playwright show-trace &lt;trace.zip&gt;</code>.</p></section><section><h2>Pass metrics</h2><pre>${escapeHtml(JSON.stringify(state.passes, null, 2))}</pre></section></body></html>`;
}

export async function run(
  config: Config,
  modelFactory: (state: State) => Model = createModel,
) {
  await mkdir(config.out, { recursive: true });
  for (const dir of ["probes", "evidence"])
    await mkdir(join(config.out, dir), { recursive: true });
  const state: State = {
    config,
    started: new Date().toISOString(),
    deadline: Date.now() + config.minutes * 60000,
    calls: 0,
    actions: 0,
    evidence: {},
    coverage: [],
    candidates: [],
    reviews: [],
    findings: [],
    passes: [],
  };
  const checkpoint = () =>
    writeFile(join(config.out, "state.json"), JSON.stringify(state, null, 2));
  const model = modelFactory(state);
  let browser: Browser | undefined;
  let serial = 0;
  const known = (ids: string[]) =>
    ids.filter((id) => Object.hasOwn(state.evidence, id));
  const available = (reservedCalls = 0) =>
    Date.now() < state.deadline &&
    state.calls < config.maxCalls &&
    state.calls + reservedCalls <= config.maxCalls &&
    state.actions < config.maxActions;
  const pass = async <T>(name: string, fn: () => Promise<T>) => {
    console.log(`\nPass: ${name}`);
    const startedAt = Date.now();
    const before = {
      calls: state.calls,
      actions: state.actions,
      coverage: state.coverage.length,
      candidates: state.candidates.length,
    };
    let failed = false;
    try {
      return await fn();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      state.passes.push({
        name,
        calls: state.calls - before.calls,
        actions: state.actions - before.actions,
        coverageAdded: state.coverage.length - before.coverage,
        candidatesAdded: state.candidates.length - before.candidates,
      });
      await checkpoint();
      console.log(
        `Pass ${failed ? "failed" : "finished"} in ${Math.ceil((Date.now() - startedAt) / 1000)}s — ${state.calls - before.calls} model calls, ${state.actions - before.actions} browser actions`,
      );
    }
  };
  const explore = async (
    journey: z.infer<typeof Journey>,
    passName: string,
    task?: unknown,
    reservedCalls = 0,
  ) => {
    console.log(`  Journey: ${journey.goal} (${journey.mode}, ${journey.width}px)`);
    const s = await session(browser!, state, journey, `session-${++serial}`);
    const history: unknown[] = [];
    try {
      history.push(await s.observe());
      for (
        let step = 0;
        step < config.maxProbes && available(reservedCalls);
        step++
      ) {
        console.log(`  Probe ${step + 1}/${config.maxProbes}`);
        const decision = await model.ask(
          passName,
          { goal: config.goal, journey, task, history },
          Decision,
          probePrompt,
        );
        history.push(decision);
        if (decision.kind === "done") {
          console.log(`  Journey ${decision.outcome}: ${decision.summary}`);
          state.coverage.push({
            journey,
            pass: passName,
            outcome: decision.outcome,
            summary: decision.summary,
          });
          if (!task)
            for (const c of decision.candidates) {
              const ids = known(c.evidenceIds);
              if (ids.length)
                state.candidates.push({
                  ...c,
                  id: `candidate-${state.candidates.length + 1}`,
                  evidenceIds: ids,
                  journey,
                });
            }
          return history;
        }
        history.push(await s.probe(decision.code));
        history.push(await s.observe());
      }
      state.coverage.push({
        journey,
        pass: passName,
        outcome: "inconclusive",
        summary: "Probe or run budget reached",
      });
      return history;
    } finally {
      await s.close();
    }
  };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    browser = await chromium.launch({ headless: config.headless });
    watchdog = setTimeout(
      () => {
        void browser?.close();
      },
      Math.max(1, state.deadline - Date.now()),
    );
    const journeys = await pass("map", async () => {
      console.log("  Opening target and collecting page structure and accessibility baseline");
      const s = await session(
        browser!,
        state,
        { id: "map", goal: config.goal, mode: "standard", width: 1280 },
        `session-${++serial}`,
      );
      try {
        const observation = await s.observe();
        await s.baseline();
        const plan = await model.ask(
          "map",
          { goal: config.goal, observation, maxJourneys: config.maxJourneys },
          z.object({ journeys: z.array(Journey).min(1) }),
          `Return {journeys:[{id,goal,mode:"standard"|"keyboard-only",width:number}]}. Propose distinct prioritized journeys, including keyboard navigation. Stay on this app. Discovery is partial.`,
        );
        const planned = plan.journeys.slice(0, config.maxJourneys);
        console.log(`  Planned ${planned.length} journeys`);
        return planned;
      } finally {
        await s.close();
      }
    });
    await pass("explore", async () => {
      for (const j of journeys) {
        if (!available()) break;
        await explore(j, "explore");
      }
    });
    const review = async () => {
      if (!available(2)) {
        console.log("  Review skipped: fewer than two model calls remain");
        return { verdicts: [], gaps: [] };
      }
      console.log("  Independently reviewing collected evidence");
      // Two stateless calls: assess raw evidence first, then reveal candidates.
      const independent = await model.ask(
        "independent-review",
        {
          goal: config.goal,
          coverage: state.coverage,
          evidence: state.evidence,
        },
        z.object({ assessment: z.string() }),
        "Return {assessment:string}. Independently assess barriers and coverage limits from raw evidence. You have not been shown candidate conclusions.",
      );
      const r = await model.ask(
        "review",
        { independent, candidates: state.candidates, coverage: state.coverage },
        Review,
        'Return {verdicts:[{id,verdict:"supported"|"rejected"|"uncertain",reason}],gaps:[{id,goal,mode:"standard"|"keyboard-only",width:number}]}. Compare candidates with independent evidence assessment. Suggest at most 3 important uncovered journeys.',
      );
      state.reviews.push({ independent, ...r });
      return r;
    };
    let reviewed = await pass("review", review);
    if (reviewed.gaps.length && available()) {
      await pass("gap-exploration", async () => {
        for (const j of reviewed.gaps.slice(0, config.maxJourneys)) {
          if (!available()) break;
          await explore(j, "gap-exploration");
        }
      });
      if (available(2)) reviewed = await pass("review-after-gaps", review);
    }
    await pass("verify", async () => {
      console.log(`  Verifying ${state.candidates.length} candidate findings`);
      for (const [index, candidate] of state.candidates.entries()) {
        console.log(`  Candidate ${index + 1}/${state.candidates.length}: ${candidate.title}`);
        const verdict = reviewed.verdicts.find((v) => v.id === candidate.id);
        if (verdict?.verdict === "rejected") {
          state.findings.push({
            candidateId: candidate.id,
            status: "rejected",
            reason: verdict.reason,
            evidenceIds: candidate.evidenceIds,
          });
          continue;
        }
        if (!available(2)) {
          state.findings.push({
            candidateId: candidate.id,
            status: "suspected",
            reason: "Insufficient model-call budget to reproduce and validate this finding",
            evidenceIds: candidate.evidenceIds,
          });
          continue;
        }
        const history = await explore(
          candidate.journey,
          "reproduce",
          {
            candidate,
            instruction:
              "Reproduce from clean state. Independently inspect expected versus observed behavior.",
          },
          1,
        );
        if (!available()) {
          state.findings.push({
            candidateId: candidate.id,
            status: "suspected",
            reason: "Verification budget exhausted after reproduction",
            evidenceIds: candidate.evidenceIds,
          });
          continue;
        }
        const result = await model.ask(
          "verify",
          { candidate, history },
          Verification,
          "Return {reproduced:boolean,validDefect:boolean,reason:string,evidenceIds:string[]}. Distinguish repeated behavior from an actual defect. Only claim reproduction with new evidence from this attempt.",
        );
        const attemptIds = new Set(
          history.flatMap((item) =>
            item && typeof item === "object" && "evidenceId" in item
              ? [String(item.evidenceId)]
              : [],
          ),
        );
        const ids = known(result.evidenceIds).filter((id) =>
          attemptIds.has(id),
        );
        state.findings.push({
          candidateId: candidate.id,
          status:
            result.reproduced && result.validDefect && ids.length
              ? "confirmed"
              : "suspected",
          reason: result.reason,
          evidenceIds: ids,
        });
      }
    });
  } catch (error) {
    state.error = String(error);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await browser?.close();
    // Candidates left unverified after an interrupted pass remain visible.
    for (const c of state.candidates)
      if (!state.findings.some((f) => f.candidateId === c.id))
        state.findings.push({
          candidateId: c.id,
          status: "suspected",
          reason: "Run ended before verification",
          evidenceIds: c.evidenceIds,
        });
    await checkpoint();
    await writeFile(
      join(config.out, "report.json"),
      JSON.stringify(state, null, 2),
    );
    await writeFile(
      join(config.out, "report.html"),
      renderHtmlReport(state),
    );
    await writeFile(
      join(config.out, "report.md"),
      `# UI test report\n\nGoal: ${config.goal}\n\n${state.error ? `Run incomplete: ${state.error}` : "Run completed."}\n\n## Findings\n\n${
        state.findings
          .map((f) => {
            const c = state.candidates.find((c) => c.id === f.candidateId)!;
            return `### ${f.status}: ${c.title}\n\nExpected: ${c.expected}\n\nObserved: ${c.observed}\n\n${f.reason}\n\nSteps:\n${c.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nEvidence: ${[...c.evidenceIds, ...f.evidenceIds].join(", ")}`;
          })
          .join("\n\n") ||
        "No agent findings. This does not establish accessibility or complete coverage."
      }\n\n## Automated accessibility baseline\n\n${renderAxeMarkdown(state)}\n\nThese are automated baseline results and may differ from the fully rendered page.\n\n## Coverage\n\n${state.coverage.map((c) => `- ${c.pass}: ${c.journey.goal} (${c.journey.mode}, ${c.journey.width}px): ${c.outcome} — ${c.summary}`).join("\n")}\n\nDeterministic axe results are in state.json under evidence. Mapping is partial; model judgments require review.\n\n## Pass metrics\n\n\`\`\`json\n${JSON.stringify(state.passes, null, 2)}\n\`\`\`\n`,
    );
  }
  return state;
}
