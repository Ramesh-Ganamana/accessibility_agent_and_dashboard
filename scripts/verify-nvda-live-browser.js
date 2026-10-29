import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { createBrowserSession } from "../src/browser/session.js";
import { createLiveNvdaSession } from "../src/assistive-technology/nvda-live.js";
import { checkNvdaRunning, focusAndMaximizeBrowser, startNvdaCaptureSession, warmNvdaKeyboardHelper } from "../src/assistive-technology/nvda.js";

// Explicit opt-in native smoke test. This opens a visible browser and owns its
// keyboard focus briefly. Do not run concurrently with another desktop test.
if (process.platform !== "win32") throw new Error("This native NVDA fixture requires an unlocked Windows desktop.");
let applicationRequests = 0;
const server = http.createServer((_request, response) => {
  applicationRequests++;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><head><title>Live NVDA fixture</title></head><body><main>
    <h1>Live reader fixture</h1><p>Sample account information for a local test only.</p>
    <h2>Account summary</h2><a href="#details">Fixture details link</a>
    <table><caption>Sample balances</caption><tr><th scope="col">Account</th><th scope="col">Amount</th></tr><tr><td>Demo</td><td>100</td></tr></table>
    <label>Existing value <input value="unchanged"></label>
    <button type="button" id="open-details" onclick="document.getElementById('details').showModal()">Open details</button>
    <dialog id="details" aria-labelledby="dialog-title"><h2 id="dialog-title">Fixture dialog</h2><p>A separate state at the same URL.</p><button type="button">First dialog action</button><button type="button">Second dialog action</button></dialog>
  </main></body></html>`);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "rambo-live-reader-"));
const targetUrl = `http://127.0.0.1:${server.address().port}/`;
const focusOnly = process.env.NVDA_FIXTURE_FOCUS_ONLY === "true";
const config = getConfig({ targetUrl, headless: false, browserChannel: "chrome", login: false, aiEnabled: false,
  nvda: { requested: true, allowed: true, tests: focusOnly ? ["focus"] : ["focus", "reading", "headings", "tables"], tabStops: 2, headingStops: 2, tableStops: 2, readingTimeoutMs: 3000 } });
let browser;
let reader;
let secondReader;
const ownedReaders = [];
const dependencies = { warm: () => warmNvdaKeyboardHelper(config.nvda), start: async (args) => { const capture = await startNvdaCaptureSession(args); ownedReaders.push(capture); return capture; } };
const waitForShutdown = async (capture, session) => {
  const deadline = Date.now() + 10_000;
  while (!capture.shutdownComplete && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(capture.shutdownComplete, true, `Closing/leaving the tab must automatically complete reader shutdown: ${JSON.stringify({ closed: capture.closed, reason: session?.finish().stoppedReason, nativeReason: capture.stoppedReason, shutdownError: capture.shutdownError })}`);
  assert.equal(checkNvdaRunning(config.nvda.executable), false, "The actual NVDA process must exit, not just become muted.");
};
let succeeded = false;
try {
  reader = await createLiveNvdaSession({ config, outputDir, dependencies });
  browser = await createBrowserSession(config);
  assert.equal(await reader.preparePage(browser.page), true, reader.finish().reason || "Native preparation failed; inspect NVDA installation and foreground permissions.");
  assert.equal(applicationRequests, 0, "NVDA startup and test-tab handoff must complete before the application is requested.");
  assert.equal(ownedReaders[0].receiver.initialized, true, "The actual NVDA core must be initialized before navigation.");
  assert.equal(ownedReaders[0].control.lifecycle, "testing");
  if (!config.nvda.fastSpeech) {
    assert.equal(ownedReaders[0].control.speechRate, config.nvda.speechRate);
  }
  await browser.page.goto(targetUrl);
  const title = await browser.page.title();
  const first = await reader.testState(browser.page, { id: "default", state: "default", url: targetUrl });
  assert.equal(first.status, "executed", JSON.stringify({ error: first.error, checks: first.checks, actions: first.actions.map((action) => ({ command: action.command, status: action.status, reason: action.reason })) }));
  for (const kind of focusOnly ? ["focus"] : ["focus", "headings", "tables"]) {
    assert.ok(first.checks[kind].commands > 0, `${kind}: ${first.checks[kind].reason || first.error || "No command confirmed"}`);
  }
  if (!focusOnly) assert.equal(first.checks.reading.status, "partial", first.checks.reading.reason);
  if (!config.nvda.fastSpeech) {
    assert.ok(first.actions.filter((action) => action.kind === "focus").every((action) => action.audibleComplete === true), "Focus announcements must finish audibly before the next command.");
    // OneCore queues parameter changes until speak(); read the actual driver
    // after completed output instead of mistaking its pending value for failure.
    assert.equal(ownedReaders[0].receiver.speechSettings?.rate, config.nvda.speechRate, "The actual synthesizer must use the configured comfortable rate while speaking.");
    assert.equal(ownedReaders[0].receiver.speechSettings?.rateBoost, false, "The actual synthesizer must have rate boost disabled.");
  }
  assert.ok(first.actions.some((action) => action.announcements.length), "Real NVDA speech must be captured, not inferred from DOM text.");
  assert.equal(await browser.page.title(), title, "The temporary capture title must be restored.");
  assert.equal(await browser.page.locator("input").inputValue(), "unchanged");
  assert.equal(await browser.page.locator("#rambo-nvda-focus-anchor").count(), 0);
  await browser.page.locator("#open-details").click();
  const dialog = await reader.testState(browser.page, { id: "dialog", state: "dialog:Fixture dialog", url: targetUrl });
  assert.equal(dialog.status, "executed", dialog.error);
  assert.equal(await browser.page.locator("dialog").evaluate((node) => node.open), true);
  assert.ok(dialog.actions.some((action) => action.announcements.length), "The same-URL dialog needs its own real speech evidence.");
  if (!config.nvda.fastSpeech) assert.ok(dialog.actions.filter((action) => action.kind === "focus").every((action) => action.audibleComplete === true), "Dialog announcements must finish audibly before the next command.");
  for (const state of [first, dialog]) {
    assert.ok(state.evidence);
    assert.ok((await fs.stat(path.join(outputDir, state.evidence))).size > 0);
  }
  const result = reader.finish();
  console.log(JSON.stringify({ applicationChecksPassed: true, readerReadyBeforeApplication: true, speechSettings: result.speechSettings, startupTiming: result.startupTiming, statesExecuted: result.coverage.statesExecuted, announcementsCaptured: result.coverage.announcementsCaptured }));
  assert.equal(result.stoppedReason, null, "The reader must stay active until the test deliberately closes its tab.");
  await browser.page.close();
  await waitForShutdown(ownedReaders[0], reader);
  // Windows can deliver foreground loss before Playwright delivers tab close.
  // Both paths must exit the actual owned process, verified above.
  assert.match(reader.finish().stoppedReason, /tab.*closed|[Ff]ocus.*testing Chrome|testing Chrome window.*unavailable/);

  const secondPage = await browser.context.newPage();
  secondReader = await createLiveNvdaSession({ config, outputDir, dependencies });
  assert.equal(await secondReader.preparePage(secondPage), true, secondReader.finish().reason);
  await secondPage.goto(targetUrl);
  const otherTab = await browser.context.newPage();
  await otherTab.goto(targetUrl);
  const otherTitle = `RAMBO NVDA alternate fixture ${Date.now()}`;
  await otherTab.evaluate((title) => { document.title = title; }, otherTitle);
  await otherTab.bringToFront();
  // CDP activation alone can leave Windows native focus in the old window.
  // Exercise a real foreground change, as a user selecting the other tab/window.
  const switched = await focusAndMaximizeBrowser(otherTitle);
  assert.equal(switched.ok, true, switched.reason);
  console.log(JSON.stringify({ switchCheck: { testingTab: await secondPage.evaluate(() => ({ visible: document.visibilityState, focused: document.hasFocus() })).catch(() => null), alternateTab: await otherTab.evaluate(() => ({ visible: document.visibilityState, focused: document.hasFocus() })).catch(() => null) } }));
  await waitForShutdown(ownedReaders[1], secondReader);
  assert.match(secondReader.finish().stoppedReason, /focus|tab|testing Chrome window.*unavailable/);
  console.log(JSON.stringify({ mode: result.coverage.mode, status: result.status, readerReadyBeforeApplication: true, startupTiming: result.startupTiming, coverage: result.coverage, tabCloseStopsProcess: true, switchingTabsStopsProcess: true, checks: result.states.map((state) => ({ state: state.state, checks: state.checks })) }, null, 2));
  succeeded = true;
} finally {
  await reader?.close();
  await secondReader?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  if (succeeded) {
    assert.equal(path.dirname(outputDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(outputDir).startsWith("rambo-live-reader-"));
    await fs.rm(outputDir, { recursive: true, force: true });
  } else console.error(`Native fixture evidence preserved at ${outputDir}`);
}
