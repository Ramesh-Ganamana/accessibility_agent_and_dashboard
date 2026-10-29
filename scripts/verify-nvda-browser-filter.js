import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { getConfig } from "../src/config.js";
import { runNvdaWebsiteTest } from "../src/assistive-technology/nvda.js";
import { captureApplicationState, clickSafeAction, inventorySafeActions } from "../src/scanner/actions.js";
import { createNvdaStateTarget } from "../src/assistive-technology/state-targets.js";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><head><title>NVDA filter fixture</title></head><body>
    <main><h1>NVDA browser filter fixture</h1>
      <a href="#one">First fixture link</a>
      <a href="#two">Second fixture link</a>
      <button type="button">Close</button>
      <input aria-label="Fixture search" type="search">
      <button type="button" id="menu-opener" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#menu-panel').hidden=false">Menu</button>
      <div id="menu-panel" role="menu" hidden>
        <button type="button" role="menuitem">Menu first</button>
        <button type="button" role="menuitem">Menu second</button>
        <button type="button" role="menuitem">Menu third</button>
        <button type="button" role="menuitem">Menu fourth</button>
      </div>
    </main>
  </body></html>`);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
const targetUrl = `http://127.0.0.1:${address.port}/`;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rambo-nvda-filter-"));
let succeeded = false;
let captureBrowser;

try {
  const config = getConfig({
    targetUrl,
    browserChannel: "chrome",
    nvda: {
      requested: true,
      allowed: true,
      maxStates: 2,
      tabStops: 4,
      startupTimeoutMs: 25_000,
      announcementWaitMs: 900,
      keyDelayMs: 350
    }
  });
  const report = {
    id: "nvda-filter-fixture",
    targetUrl,
    pages: [{ url: targetUrl, actualUrl: targetUrl, title: "NVDA filter fixture", observedStates: [] }]
  };
  captureBrowser = await chromium.launch({ headless: true });
  const capturePage = await captureBrowser.newPage();
  await capturePage.goto(targetUrl);
  const baseline = await captureApplicationState(capturePage);
  const opener = (await inventorySafeActions(capturePage)).find((action) => action.label === "Menu");
  assert.ok((await clickSafeAction(capturePage, opener)).clicked);
  const menuSnapshot = await captureApplicationState(capturePage);
  const stateTargets = [
    createNvdaStateTarget({ id: targetUrl, stateId: "base", state: "default", url: targetUrl, pageUrl: targetUrl, title: "Fixture", snapshot: baseline, replay: { baseUrl: targetUrl, path: [] } }),
    createNvdaStateTarget({ id: `${targetUrl}::menu`, stateId: "menu", state: "interaction:Menu", url: targetUrl, pageUrl: targetUrl, title: "Menu", snapshot: menuSnapshot, replay: { baseUrl: targetUrl, path: [opener] } })
  ];
  await captureBrowser.close(); captureBrowser = null;
  const result = await runNvdaWebsiteTest({ report, config, storageState: null, stateTargets, outputDir: tempRoot });
  console.log(JSON.stringify({
    status: result.status,
    outcome: result.outcome,
    reason: result.reason,
    warnings: result.warnings,
    statesExecuted: result.coverage?.statesExecuted,
    keyboardCommands: result.coverage?.keyboardCommands,
    announcementsCaptured: result.coverage?.announcementsCaptured,
    announcements: result.states?.map((state) => ({ state: state.state, actions: state.actions?.map((action) => action.announcements) })) || []
  }, null, 2));
  assert.equal(result.actualExecution, true, result.reason || result.warnings?.join(" | "));
  assert.equal(result.coverage.statesExecuted, 2);
  assert.equal(result.coverage.keyboardCommands, 8);
  const actions = result.states[0].actions;
  assert.equal(actions.length, 4);
  assert.ok(actions.every((action) => action.focus?.documentFocused), "Every accepted action must retain document focus.");
  assert.deepEqual(actions.map((action) => action.focus?.tag), ["a", "a", "button", "input"], "Native Tab must traverse the webpage controls, not the browser toolbar.");
  assert.ok(actions.flatMap((action) => action.announcements).some((announcement) => /First fixture link/i.test(announcement)), "NVDA must announce the fixture webpage, not browser chrome.");
  assert.ok(actions[2].announcements.some((announcement) => /Close button/i.test(announcement)), "A website Close button must not be discarded as browser chrome.");
  assert.ok(actions.filter((action) => action.announcements.length).every((action) => action.capture?.foregroundProcessId), "Captured speech must include a verified foreground browser process.");
  const menuActions = result.states[1].actions;
  assert.equal(menuActions.length, 4);
  assert.ok(menuActions[0].announcements.some((announcement) => /Menu first/i.test(announcement)), "The same-URL menu must produce its own actual NVDA announcement.");
  assert.ok(menuActions.every((action) => !action.stateChanged), "The keyboard helper must preserve the opened menu.");
  succeeded = true;
} finally {
  await captureBrowser?.close();
  await new Promise((resolve) => server.close(resolve));
  if (succeeded && path.basename(tempRoot).startsWith("rambo-nvda-filter-") && path.dirname(tempRoot) === path.resolve(os.tmpdir())) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  } else if (!succeeded) {
    console.error(`NVDA smoke-test evidence preserved at ${tempRoot}`);
  }
}
