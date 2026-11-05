import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Model, State } from "./types.js";
import { run } from "./runner.js";

// Scripted responses exercise orchestration; this is not a model-quality benchmark.
export function demoModel(state: State, invalidEvidence = false): Model {
  let gap = false;
  return {
    async ask(pass, input, schema) {
      state.calls++;
      const data = input as any;
      const journey = {
        id: "rename",
        goal: "Rename Old to New",
        mode: "standard",
        width: 1280,
      };
      let result: unknown;
      if (pass === "map") result = { journeys: [journey] };
      else if (pass === "independent-review")
        result = {
          assessment:
            "The rename action leaves Old visible. Keyboard coverage is missing.",
        };
      else if (pass === "review") {
        result = {
          verdicts: state.candidates.map((c) => ({
            id: c.id,
            verdict: "supported",
            reason: "Observed name unchanged after Save",
          })),
          gaps: gap
            ? []
            : [
                {
                  ...journey,
                  id: "keyboard",
                  mode: "keyboard-only",
                  goal: "Reach Rename with keyboard",
                },
              ],
        };
        gap = true;
      } else if (pass === "verify") {
        const ids = data.history
          .filter((v: any) => v.evidenceId)
          .map((v: any) => v.evidenceId);
        result = {
          reproduced: true,
          validDefect: true,
          reason: "Save leaves the original project name visible",
          evidenceIds: invalidEvidence ? ["invented"] : ids,
        };
      } else {
        const probed = data.history.some((v: any) => v.kind === "probe");
        if (!probed)
          result = {
            kind: "probe",
            purpose: "Exercise rename",
            code:
              data.journey.mode === "keyboard-only"
                ? 'await ui.press("Tab"); return await ui.observe();'
                : 'await ui.click("button","Rename"); await ui.fill("textbox","Project name","New"); await ui.click("button","Save"); return await ui.observe();',
          };
        else {
          const ids = data.history
            .filter((v: any) => v.evidenceId)
            .map((v: any) => v.evidenceId);
          result = {
            kind: "done",
            outcome: "completed",
            summary: "Observed task result",
            candidates:
              data.task || data.journey.mode === "keyboard-only"
                ? []
                : [
                    {
                      id: "rename-failure",
                      title: "Save fails to rename project",
                      expected: "Project name becomes New",
                      observed: "Project remains Old",
                      steps: ["Click Rename", "Enter New", "Click Save"],
                      evidenceIds: ids,
                    },
                  ],
          };
        }
      }
      return schema.parse(result);
    },
  };
}
export async function demo(
  out = resolve("runs/demo"),
  invalidEvidence = false,
) {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><html lang="en"><title>Rename fixture</title><body><main><h1>Old</h1><button onclick="document.querySelector('form').hidden=false">Rename</button><form hidden onsubmit="event.preventDefault();this.hidden=true"><label>Project name<input></label><button>Save</button></form></main></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No server port");
  try {
    return await run(
      {
        url: `http://127.0.0.1:${address.port}`,
        goal: "Rename project and check keyboard access",
        out,
        maxCalls: 30,
        maxActions: 100,
        maxProbes: 3,
        maxJourneys: 2,
        minutes: 2,
        headless: true,
      },
      (s) => demoModel(s, invalidEvidence),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const state = await demo();
  console.log(`Demo report: ${state.config.out}/report.md`);
  if (state.error) {
    console.error(state.error);
    process.exitCode = 1;
  }
}
