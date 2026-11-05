import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { z } from "zod";
import { createModel } from "../src/model.js";
import type { State } from "../src/types.js";

test("HTTP adapter uses stateless calls, validates JSON and enforces call budget", async () => {
  const requests: any[] = [];
  let reply = '{"assessment":"Evidence reviewed"}';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const old = {
    endpoint: process.env.LLM_ENDPOINT,
    model: process.env.LLM_MODEL,
  };
  process.env.LLM_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.LLM_MODEL = "fixture";
  try {
    const state = {
      calls: 0,
      deadline: Date.now() + 10000,
      config: { maxCalls: 2 },
    } as State;
    const model = createModel(state);
    const schema = z.object({ assessment: z.string() });
    assert.deepEqual(
      await model.ask("review", { evidence: "test" }, schema, "Review it"),
      { assessment: "Evidence reviewed" },
    );
    reply = '{"unexpected":true}';
    await assert.rejects(() => model.ask("review", {}, schema, "Review it"));
    await assert.rejects(
      () => model.ask("review", {}, schema, "Review it"),
      /budget exhausted/,
    );
    assert.equal(requests.length, 2);
    assert(requests.every((r) => r.messages.length === 2));
  } finally {
    if (old.endpoint === undefined) delete process.env.LLM_ENDPOINT;
    else process.env.LLM_ENDPOINT = old.endpoint;
    if (old.model === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = old.model;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
