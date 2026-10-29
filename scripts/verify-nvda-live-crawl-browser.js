import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";
import { checkNvdaRunning } from "../src/assistive-technology/nvda.js";

// Explicit desktop opt-in. This runs the real crawler and real NVDA against
// two local English states. It brings Chrome forward and speaks, not a mock.
if (process.platform !== "win32") throw new Error("An interactive Windows desktop is required.");
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><head><title>Sequential NVDA check</title></head><body>
    <main><h1>Local accessibility demonstration</h1>
      <p>This is a sample page. No customer data or transactions are used.</p>
      <p>Home reading finish marker.</p>
      <button type="button" onclick="document.getElementById('details').showModal()">Open details</button>
      <dialog id="details" aria-labelledby="details-title"><h2 id="details-title">Local details</h2>
        <p>This dialog is a second state at the same address.</p>
        <p>Dialog reading finish marker.</p>
        <button type="button" onclick="this.closest('dialog').close()">Close</button>
      </dialog>
    </main></body></html>`);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "rambo-sequential-nvda-"));
const targetUrl = `http://127.0.0.1:${server.address().port}/`;
const config = getConfig({ targetUrl, login: false, headless: false, browserChannel: "chrome", aiEnabled: false,
  maxPages: 1, maxStates: 2, maxDepth: 1,
  nvda: { requested: true, allowed: true, mode: "during-crawl", tests: ["reading", "headings", "focus"], headingStops: 1, tabStops: 3, readingTimeoutMs: 90000, speechRate: 40, fastSpeech: false }
});
Object.assign(config, { reportsDir, authStatePath: path.join(reportsDir, "auth.json"), legacyAuthStatePath: null, documentsMax: 0, keyboardMaxTabs: 4 });
const events = [];
try {
  assert.equal(checkNvdaRunning(config.nvda.executable), false, "Exit any personal NVDA instance before the dedicated test.");
  const report = await runAccessibilityScan(config, (event) => {
    events.push(event);
    if (["nvda", "nvda-warning", "nvda-complete", "state", "complete"].includes(event.type)) console.log(event.message);
  });
  const run = report.assistiveTechnology.actualRuns.NVDA;
  const diagnostic = JSON.stringify({ reportStatus: report.status, status: run.status, reason: run.reason, coverage: run.coverage,
    states: run.states?.map(({ state, status, error }) => ({ state, status, error })), reportsDir });
  assert.equal(report.status, "complete", diagnostic);
  assert.equal(run.executionMode, "live-during-crawl");
  assert.equal(run.actualExecution, true, run.reason || JSON.stringify(run.warnings));
  assert.equal(run.coverage.statesExecuted, 2, diagnostic);
  assert.equal(run.coverage.readingCompleted, 2, diagnostic);
  assert.equal(run.stoppedReason, null, "normal cleanup must not be reported as cancellation");
  const home = run.states.find((state) => state.state === "default");
  const dialog = run.states.find((state) => state.state.startsWith("dialog:"));
  for (const [state, marker] of [[home, /Home reading finish marker/i], [dialog, /Dialog reading finish marker/i]]) {
    assert.ok(state, "both same-URL states must have separate evidence");
    const reading = state.actions.find((action) => action.kind === "reading");
    assert.equal(reading.readingCompletion, "completed");
    assert.equal(reading.audibleComplete, true);
    assert.match(reading.announcements.join(" "), marker);
    assert.ok(state.evidence || reading.evidence, "retain screenshot evidence");
    assert.ok(state.actions.some((action) => action.kind === "headings" && action.status === "executed"), "heading navigation must run before moving to the next state");
    assert.ok(state.actions.some((action) => action.kind === "focus" && action.status === "executed"), "native Tab checks must run on both states");
    assert.equal(state.actions.filter((action) => action.kind === "reading").length, 1, "completed reading must not be repeated on recovery");
  }
  assert.equal(events.some((event) => /Crawl complete. Starting NVDA/.test(event.message || "")), false);
  assert.equal(events.some((event) => event.type === "user-tab"), false);
  assert.equal(checkNvdaRunning(config.nvda.executable), false, "owned NVDA must stop after the crawl");
  console.log(JSON.stringify({ passed: true, statesTested: run.coverage.statesExecuted, completedReadings: run.coverage.readingCompleted, announcements: run.coverage.announcementsCaptured, reportId: report.id }));
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`Sequential NVDA evidence: ${reportsDir}`);
}
