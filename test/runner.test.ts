import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { demo } from "../src/demo.js";

test("multi-pass workflow finds, independently reviews, fills a gap, and reproduces a real fixture defect", async () => {
  const out = await mkdtemp(resolve("test-run-"));
  try {
    const state = await demo(out);
    assert.equal(state.error, undefined);
    assert.equal(state.findings[0]?.status, "confirmed");
    assert(state.passes.some((p) => p.name === "gap-exploration"));
    assert(state.coverage.some((c) => c.journey.mode === "keyboard-only"));
    const evidence = Object.values(state.evidence)
      .map((v) => JSON.stringify(v))
      .join("\n");
    assert.match(evidence, /Old/);
    assert.match(evidence, /Save/);
    assert.match(
      await readFile(join(out, "report.md"), "utf8"),
      /confirmed: Save fails/,
    );
    const html = await readFile(join(out, "report.html"), "utf8");
    assert.match(html, /JourneyLens report/);
    assert.match(html, /confirmed: Save fails/);
    assert.match(html, /session-1-trace.zip/);
    assert.match(html, /Automated accessibility baseline/);
    const sessions = new Set(
      Object.keys(state.evidence).map((id) =>
        id.split("-").slice(0, 2).join("-"),
      ),
    );
    assert(
      sessions.size >= 4,
      "mapping, exploration, gap exploration and reproduction use distinct sessions",
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("a model claim without valid reproduction evidence remains suspected", async () => {
  const out = await mkdtemp(resolve("test-run-"));
  try {
    const state = await demo(out, true);
    assert.equal(state.error, undefined);
    assert.equal(state.findings[0]?.status, "suspected");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
