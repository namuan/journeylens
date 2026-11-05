import type { Browser } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import type { Journey, State } from "./types.js";

export async function session(
  browser: Browser,
  state: State,
  journey: Journey,
  label: string,
) {
  const context = await browser.newContext({
    viewport: { width: journey.width, height: 900 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.tracing.start({ screenshots: true, snapshots: true });
  let active = true,
    sequence = 0;
  const record = async (value: unknown) => {
    const id = `${label}-${++sequence}`;
    state.evidence[id] = value;
    await appendFile(
      join(state.config.out, "events.jsonl"),
      JSON.stringify({ id, time: new Date().toISOString(), value }) + "\n",
    );
    return { evidenceId: id, value };
  };
  const action = async (
    name: string,
    args: unknown,
    fn: () => Promise<unknown>,
  ) => {
    if (
      !active ||
      Date.now() >= state.deadline ||
      state.actions >= state.config.maxActions
    )
      throw new Error("Session closed or action budget exhausted");
    state.actions++;
    console.log(`    Browser action ${state.actions}/${state.config.maxActions}: ${name}`);
    try {
      return await record({ operation: name, args, result: await fn() });
    } catch (error) {
      await record({ operation: name, args, error: String(error) });
      throw error;
    }
  };
  const observe = () =>
    action("observe", {}, async () => ({
      url: page.url(),
      tree: (await page.locator("body").ariaSnapshot()).slice(0, 24000),
      focus: await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        text: document.activeElement?.textContent?.trim().slice(0, 200),
        label: document.activeElement?.getAttribute("aria-label"),
      })),
      errors: [...errors],
    }));
  const screenshot = () =>
    action("screenshot", {}, async () => {
      const file = `${label}-${sequence + 1}.png`;
      await page.screenshot({
        path: join(state.config.out, "evidence", file),
        fullPage: true,
      });
      return { file: `evidence/${file}` };
    });
  const ui: Record<string, unknown> = {
    observe,
    screenshot,
    press: (key: string) =>
      action("press", { key }, () => page.keyboard.press(key)),
    scroll: (dy: number) =>
      action("scroll", { dy }, () => page.mouse.wheel(0, dy)),
  };
  if (journey.mode === "standard")
    Object.assign(ui, {
      click: (role: Parameters<typeof page.getByRole>[0], name: string) =>
        action("click", { role, name }, () =>
          page.getByRole(role, { name, exact: true }).click(),
        ),
      fill: (
        role: Parameters<typeof page.getByRole>[0],
        name: string,
        text: string,
      ) =>
        action("fill", { role, name, text }, () =>
          page.getByRole(role, { name, exact: true }).fill(text),
        ),
    });
  // Setup navigation is separate from the agent's interaction permissions.
  try {
    await page.goto(state.config.url, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  } catch (error) {
    await context.close();
    throw error;
  }
  return {
    observe,
    async baseline() {
      const axe = await new AxeBuilder({ page }).analyze();
      return record({
        kind: "baseline",
        violations: axe.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            failureSummary: n.failureSummary,
          })),
        })),
        overflow: await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        errors: [...errors],
      });
    },
    async probe(code: string) {
      const file = `${label}-probe-${sequence + 1}.js`;
      await writeFile(join(state.config.out, "probes", file), code);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const script = new vm.Script(
          `(async function(ui){"use strict";\n${code}\n})(ui)`,
        );
        const result = await Promise.race([
          script.runInNewContext({ ui: Object.freeze(ui) }, { timeout: 1000 }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              active = false;
              void context.close();
              reject(new Error("Probe timeout; session terminated"));
            }, 15000);
          }),
        ]);
        return await record({
          kind: "probe",
          file: `probes/${file}`,
          result: result ?? null,
        });
      } catch (error) {
        return record({
          kind: "probe",
          file: `probes/${file}`,
          error: String(error),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async close() {
      active = false;
      await context.tracing
        .stop({
          path: join(state.config.out, "evidence", `${label}-trace.zip`),
        })
        .catch(() => {});
      await context.close();
    },
  };
}
