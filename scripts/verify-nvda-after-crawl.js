import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";

// Crawl-first NVDA order with an injected adapter (no real NVDA or desktop
// keys): the crawl finishes, then NVDA starts on a new blank tab of the same
// browser and each recorded state is reopened before it is tested.
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><head><title>After-crawl fixture</title></head><body>
    <main><h1>Application dashboard</h1>
      <label>Existing value <input value="leave-me-unchanged"></label>
      <button type="button" onclick="document.getElementById('panel').hidden=false">Open details</button>
      <section id="panel" role="dialog" aria-label="Account details" hidden><h2>Account details</h2><p>Current account information</p></section>
      <button type="button" onclick="if (!localStorage.tipShown) { localStorage.tipShown = '1'; document.getElementById('tip').hidden = false; }">One-time tip</button>
      <section id="tip" role="dialog" aria-label="Tip" hidden><h2>Tip</h2><p>Shown only once per browser.</p></section>
      <button type="button" onclick="document.body.dataset.mutated='yes'">Transfer funds</button>
    </main></body></html>`);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-nvda-after-"));
const targetUrl = `http://127.0.0.1:${server.address().port}`;
try {
  for (const replayFails of [false, true]) {
  const events = [];
  const tested = [];
  let preparedPage = null;
  let closed = false;
  let closedWhileReaderActive = false;
  const onPageClosed = () => { closedWhileReaderActive = true; };
  const factory = async () => {
    assert.ok(events.some((event) => event.type === "nvda" && /Crawl complete/.test(event.message)), "NVDA starts only after the crawl");
    return {
      async preparePage(page) {
        assert.equal(page.url(), "about:blank", "NVDA is attached on a blank tab before any application navigation");
        assert.ok(page.context().pages().length >= 2, "a new tab of the crawl browser is used, keeping the signed-in session");
        preparedPage = page;
        page.on("close", onPageClosed);
        if (replayFails) await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<html><body><main><h1>Changed application</h1><p>The captured controls no longer exist.</p></main></body></html>" }));
        return true;
      },
      async testState(page, meta) {
        assert.equal(page, preparedPage);
        assert.equal(meta.executionMode, "after-crawl");
        assert.equal(new URL(page.url()).origin, targetUrl);
        assert.equal(await page.locator("input").inputValue(), "leave-me-unchanged");
        assert.equal(await page.locator("body").getAttribute("data-mutated"), null, "no transaction control was clicked");
        if (/Account details/.test(meta.state)) assert.ok(await page.locator("#panel").isVisible(), "the dialog state is reopened before testing");
        tested.push(meta.state);
        return { id: meta.id, state: meta.state, status: "fixture-only", actions: [] };
      },
      async finish() {
        assert.equal(preparedPage.isClosed(), false, "collect the actual result before normal tab cleanup");
        return { product: "NVDA", status: "fixture-only", actualExecution: false, states: tested, coverage: { statesAttempted: tested.length }, warnings: [] };
      },
      async close() { preparedPage.off("close", onPageClosed); closed = true; }
    };
  };
  const config = getConfig({
    targetUrl, maxPages: 1, maxStates: 5, maxDepth: 1, headless: true, browserChannel: "bundled",
    login: false, aiEnabled: false, nvda: { requested: true, mode: "after-crawl" }, nvdaSessionFactory: factory
  });
  config.reportsDir = reportsDir;
  config.authStatePath = path.join(reportsDir, "auth.json");
  config.legacyAuthStatePath = null;
  assert.equal(config.nvda.mode, "after-crawl", "replay mode is explicitly selected");
  const report = await runAccessibilityScan(config, (event) => events.push(event));
  const nvda = report.assistiveTechnology.actualRuns.NVDA;
  assert.ok(closed, "the NVDA adapter is closed after its pass");
  assert.equal(closedWhileReaderActive, false, "cleanup must not produce a tab-closed failure");
  assert.equal(preparedPage.isClosed(), true, "internal test tabs are still cleaned up");
  assert.equal(events.some((event) => event.type === "user-tab" || event.type === "browser-closed"), false, "an internal replay tab and normal cleanup are not user actions");
  assert.equal(nvda.executionMode, "after-crawl");
  if (replayFails) {
    assert.equal(tested.length, 0);
    assert.equal(nvda.coverage.statesNotReplayed, 3);
    assert.equal(nvda.outcome, "not-executed");
    assert.match(nvda.reason, /could not be reopened/);
    assert.doesNotMatch(nvda.reason, /tab.*closed/i);
    continue;
  }
  assert.ok(tested.includes("default") && tested.some((state) => /Account details/.test(state)), `default view and dialog are tested (${tested.join(", ")})`);
  assert.equal(nvda.coverage.statesNotReplayed, 1, JSON.stringify(nvda.warnings));
  // The one-time tip only appears once per browser, so its state cannot be
  // reproduced: it is reported instead of being tested under its label.
  assert.equal(tested.length, 2, `only reproducible states are tested (${tested.join(", ")})`);
  assert.match(nvda.warnings.join(" "), /could not be reopened: .*did not reproduce the captured content/);
  const lastState = events.findLastIndex((event) => event.type === "state");
  const firstNvda = events.findIndex((event) => event.type === "nvda");
  assert.ok(lastState < firstNvda, "every crawl state is scanned before NVDA starts");
  assert.ok(report.issues.length + report.incomplete.length + report.pages[0].ruleOutcomes.length > 0, "crawl results are complete regardless of NVDA");
  console.log(`NVDA after crawl passed: crawl first, NVDA on a new blank tab, ${tested.length} replayed state(s) tested, 1 unreproducible state reported, no transaction clicked (mock adapter).`);
  }
  console.log("All-replay-failure reason preserved; internal tab cleanup cannot overwrite it (mock adapter).");
} finally {
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(reportsDir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(reportsDir).startsWith("clarity-nvda-after-"));
  await fs.rm(reportsDir, { recursive: true, force: true });
}
