import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { createBrowserSession } from "../src/browser/session.js";
import { createLiveNvdaSession } from "../src/assistive-technology/nvda-live.js";
import { startNvdaCaptureSession } from "../src/assistive-technology/nvda.js";

// Explicit desktop opt-in: actual English speech, not a mocked NVDA result.
if (process.platform !== "win32") throw new Error("An interactive Windows desktop is required.");
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><head><title>English reading test</title></head><body><main>
    <h1>English accessibility reading check</h1>
    <p>This is a local sample, not a customer website. The agent must allow the voice to finish each sentence before moving to another action.</p>
    <h2>Account information</h2>
    <p>You can review your account details, check your available balance and read recent activity. These are sample values only. No payment, purchase or account change will be performed.</p>
    <h2>Help and accessibility</h2>
    <p>Clear headings help a listener understand the page. Descriptive links identify their destination. Accessible form labels explain which information is requested. Reading must continue through the final paragraph, not stop after the first few seconds.</p>
    <p>The reading test is now approaching the end of this sample. This last sentence must be captured and allowed to finish aloud.</p>
    <p>English reading finish marker.</p>
  </main></body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "rambo-english-reading-"));
const targetUrl = `http://127.0.0.1:${server.address().port}/`;
const config = getConfig({ targetUrl, headless: false, browserChannel: "chrome", login: false, aiEnabled: false,
  nvda: { requested: true, allowed: true, tests: ["reading"], readingTimeoutMs: 180000, fastSpeech: false, speechRate: 40 } });
let browser, reader, ownedCapture;
try {
  reader = await createLiveNvdaSession({ config, outputDir, emit: (event) => console.log(event.message),
    dependencies: { start: async (args) => { ownedCapture = await startNvdaCaptureSession(args); return ownedCapture; } } });
  browser = await createBrowserSession(config);
  assert.equal(await reader.preparePage(browser.page), true, reader.finish().reason);
  await browser.page.goto(targetUrl);
  const state = await reader.testState(browser.page, { id: "english-reading", state: "default", url: targetUrl });
  const result = reader.finish();
  await fs.writeFile(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  const reading = state.actions.find((action) => action.kind === "reading");
  assert.ok(reading, state.error || "No reading command ran");
  assert.match(reading.announcements.join(" "), /English reading finish marker/i);
  assert.equal(reading.readingCompletion, "completed", JSON.stringify(reading));
  assert.equal(reading.audibleComplete, true);
  assert.equal(result.coverage.readingCompleted, 1);
  assert.equal(result.speechSettings?.rate, 40);
  assert.equal(result.speechSettings?.rateBoost, false);
  await reader.close();
  assert.equal(ownedCapture.shutdownComplete, true, ownedCapture.shutdownError || "The owned NVDA process must stop after testing");
  console.log(JSON.stringify({ passed: true, readingCompletion: reading.readingCompletion, audibleComplete: reading.audibleComplete, durationMs: state.durationMs, speechSettings: result.speechSettings }));
} finally {
  await reader?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  console.log(`English reading evidence: ${outputDir}`);
}
