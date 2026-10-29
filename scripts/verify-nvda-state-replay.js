import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";
import { restoreNvdaState, selectNvdaStates } from "../src/assistive-technology/state-targets.js";
import { establishPageKeyboardFocus } from "../src/assistive-technology/nvda.js";
import { inventorySafeActions } from "../src/scanner/actions.js";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><head><title>State replay fixture</title></head><body><main>
    <h1>Account workspace</h1>
    <button type="button" id="menu" aria-expanded="false" onclick="show('menu-panel');this.setAttribute('aria-expanded','true')">Menu</button>
    <button type="button" id="details" onclick="show('dialog-panel')">Details</button>
    <button type="button" id="activity" role="tab" aria-selected="false" onclick="show('tab-panel');this.setAttribute('aria-selected','true')">Activity</button>
    <section hidden id="menu-panel"><h2>Navigation menu</h2><a href="#help">Menu help</a></section>
    <section hidden id="dialog-panel" role="dialog" aria-label="Details"><h2>Account details</h2><button type="button">Close</button></section>
    <section hidden id="tab-panel"><h2>Recent activity</h2><a href="#item">Activity item</a></section>
    <form onsubmit="event.preventDefault();window.submitted=true"><label>Message <input name="message" value="Untouched"></label><button type="submit">Send</button></form>
    </main><script>
      function show(id) {
        for (const panel of document.querySelectorAll('section')) panel.hidden = panel.id !== id;
        document.querySelector('#menu').setAttribute('aria-expanded','false');
        document.querySelector('#activity').setAttribute('aria-selected','false');
      }
    </script></body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const targetUrl = `http://127.0.0.1:${server.address().port}`;
const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "rambo-nvda-states-"));
let browser;
let calls = 0;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const focusPage = await context.newPage();
  await focusPage.setContent('<main><h1>Focus fixture</h1></main><span role="button" tabindex="0">Menu</span>');
  const beforeAnchor = (await inventorySafeActions(focusPage)).find((action) => action.label === "Menu");
  assert.equal(await establishPageKeyboardFocus(focusPage), true);
  const afterAnchor = (await inventorySafeActions(focusPage)).find((action) => action.label === "Menu");
  assert.equal(afterAnchor.signature, beforeAnchor.signature, "focus preparation must not change span-control paths");
  await focusPage.setContent('<div role="dialog" aria-modal="true"><h1>Auto-open dialog</h1><button>Details</button></div>');
  await focusPage.evaluate(() => document.addEventListener("click", () => document.querySelector('[role="dialog"]')?.remove()));
  assert.equal(await establishPageKeyboardFocus(focusPage), true);
  assert.equal(await focusPage.locator('[role="dialog"]').isVisible(), true, "focus preparation must not trigger click-away dismissal");
  await focusPage.close();
  const config = getConfig({ targetUrl, login: false, aiEnabled: false, browserChannel: "bundled", headless: true,
    maxPages: 1, maxStates: 8, maxDepth: 1, nvda: { requested: true, maxStates: 8 },
    nvdaRunner: async ({ report, stateTargets }) => {
      calls += 1;
      const selected = selectNvdaStates(report, stateTargets, 8);
      assert.equal(selected.targets.length, 4, "one URL must retain default, menu, dialog, and tab targets");
      assert.equal(new Set(selected.targets.map((entry) => entry.url)).size, 1);
      assert.equal(JSON.stringify(report).includes('"replay":'), false, "replay actions must not be persisted in reports");
      for (const target of selected.targets) {
        const page = await context.newPage();
        let preparationCalls = 0;
        const restored = await restoreNvdaState(page, target, { beforeReplay: async () => {
          preparationCalls += 1;
          await page.evaluate(() => { document.title = "RAMBO NVDA fixture"; });
          assert.equal(await establishPageKeyboardFocus(page), true);
        } });
        assert.equal(preparationCalls, 1);
        if (target.state.startsWith("dialog:")) assert.ok(restored.dialogs.length);
        if (target.state.includes("Activity")) assert.ok(restored.selectedTabs.includes("Activity"));
        assert.equal(await page.locator('input[name="message"]').inputValue(), "Untouched");
        assert.equal(await page.evaluate(() => Boolean(window.submitted)), false);
        await page.close();
      }
      const dialog = selected.targets.find((entry) => entry.state.startsWith("dialog:"));
      const page = await context.newPage();
      await assert.rejects(restoreNvdaState(page, { ...dialog, identity: "wrong-state" }), /did not reproduce/);
      await assert.rejects(restoreNvdaState(page, { ...dialog, replay: null }), /No safe replay recipe/);
      await assert.rejects(restoreNvdaState(page, dialog, { excludeLabels: ["Details"] }), /excluded/);
      await assert.rejects(restoreNvdaState(page, { ...dialog, replay: { baseUrl: "https://external.test/", path: [] } }), /same-origin/);
      await page.close();
      // This fixture verifies replay/orchestration, not actual screen-reader speech.
      return { product: "NVDA", actualExecution: false, status: "not-run", outcome: "not-executed", states: [], reason: "Replay fixture only" };
    }
  });
  config.reportsDir = reportsDir;
  config.authStatePath = path.join(reportsDir, "auth-state.json");
  const report = await runAccessibilityScan(config);
  assert.equal(calls, 1);
  assert.equal(report.assistiveTechnology.actualRuns.NVDA.status, "not-run", report.assistiveTechnology.actualRuns.NVDA.reason);
  console.log("Single-URL NVDA targets, menu/dialog/tab replay, input protection, identity mismatch, exclusions, and private replay recipes passed (no native NVDA execution).");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(reportsDir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(reportsDir).startsWith("rambo-nvda-states-"));
  await fs.rm(reportsDir, { recursive: true, force: true });
}
