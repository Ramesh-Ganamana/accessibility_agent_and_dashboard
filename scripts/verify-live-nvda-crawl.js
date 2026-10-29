import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";
import { buildAudit } from "../src/report/audit.js";

// Integration fixture: verifies crawl timing/state attribution with an injected
// adapter. It does not claim a real NVDA run or send desktop keyboard commands.
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><head><title>Shared audit fixture</title></head><body>
    <main><h1>Application dashboard</h1>
      <script>window.clicksDuringNvda = 0; addEventListener('click', () => { if (window.nvdaPending) window.clicksDuringNvda++; }, true);</script>
      <label>Existing value <input value="leave-me-unchanged"></label>
      <button type="button" id="details" onclick="document.getElementById('panel').hidden=false">Open details</button>
      <section id="panel" role="dialog" aria-label="Account details" hidden><h2>Account details</h2><p>Current account information</p></section>
      <button type="button" role="tab" aria-selected="false" onclick="this.setAttribute('aria-selected','true');document.getElementById('activity').hidden=false">Activity</button>
      <section id="activity" hidden><h2>Activity history</h2><p>Recent activity entries</p></section>
      <button type="button" onclick="document.body.dataset.mutated='yes'">Transfer funds</button>
      <button type="button" onclick="document.body.dataset.mutated='yes'">Sell</button>
    </main></body></html>`);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-live-nvda-"));
const targetUrl = `http://127.0.0.1:${server.address().port}`;
try {
  for (const profile of ["general", "financial"]) {
    const tested = [];
    const events = [];
    let closed = false;
    let prepared = false;
    let browserPage;
    const factory = async () => ({
      async preparePage(page) {
        assert.equal(page.url(), "about:blank", "native preparation must precede application/login navigation");
        prepared = true;
        browserPage = page;
      },
      async testState(page, meta) {
        assert.ok(prepared);
        assert.equal(page, browserPage, "NVDA must use the same crawler page, not a replay browser");
        assert.equal(new URL(page.url()).origin, targetUrl);
        assert.equal(await page.locator("input").inputValue(), "leave-me-unchanged");
        assert.equal(await page.locator("body").getAttribute("data-mutated"), null, "no financial transaction was executed");
        if (meta.state.startsWith("dialog:")) assert.ok(await page.locator("#panel").isVisible(), "test the dialog before leaving it");
        if (meta.state !== "default") assert.ok(events.some((event) => event.type === "state"));
        assert.equal(page.context().pages().length, 1, "live testing must not create a replay tab");
        const before = await page.locator("main").innerHTML();
        await page.evaluate(() => { window.nvdaPending = true; });
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(await page.evaluate(() => window.clicksDuringNvda), 0, "crawler clicks must wait for NVDA");
        assert.equal(await page.locator("main").innerHTML(), before, "the crawler must not change the state during NVDA");
        await page.evaluate(() => { window.nvdaPending = false; });
        events.push({ type: "fixture-nvda-finished", state: meta.state });
        tested.push({ id: meta.id, state: meta.state, status: "fixture-only" });
        return { stateChanged: false };
      },
      async finish() {
        assert.ok(tested.length >= 3, "default view and same-URL UI states should be tested");
        return { product: "NVDA", status: "fixture-only", actualExecution: false, states: tested, coverage: { statesAttempted: tested.length } };
      },
      async close() { closed = true; }
    });
    const config = getConfig({
      targetUrl, maxPages: 1, maxStates: 3, maxDepth: 1, headless: true, browserChannel: "bundled",
      login: false, aiEnabled: false, audit: { profile, wcagVersion: profile === "general" ? "2.1" : "2.2" },
      nvda: { requested: true }, nvdaSessionFactory: factory
    });
    config.reportsDir = reportsDir;
    assert.equal(config.nvda.mode, "during-crawl", "new scans test live states by default");
    config.authStatePath = path.join(reportsDir, "auth.json");
    const report = await runAccessibilityScan(config, (event) => events.push(event));
    assert.ok(closed, "the adapter is cleaned up after the scan");
    assert.equal(report.pages.length, 1);
    assert.equal(report.pages[0].error, null);
    assert.equal(report.configuration.audit.profile, profile);
    assert.equal(report.configuration.nvdaMode, "during-crawl");
    assert.equal(events.some((event) => /Crawl complete. Starting NVDA/.test(event.message || "")), false);
    assert.ok(events.findIndex((event) => event.type === "fixture-nvda-finished") < events.findIndex((event) => event.type === "state"), "the default state's NVDA test must finish before the next state is opened");
    assert.equal(report.assistiveTechnology.actualRuns.NVDA.status, "fixture-only", JSON.stringify({ reason: report.assistiveTechnology.actualRuns.NVDA.reason, tested, limitations: report.limitations }));
    assert.equal(report.assistiveTechnology.actualRuns.NVDA.states.length, 3);
    const audit = buildAudit(report);
    assert.equal(audit.criteria.length, profile === "general" ? 50 : 55);
    assert.equal(audit.checks.some((check) => check.id === "financial-payments"), profile === "financial");
    assert.equal(audit.criteria.every((row) => row.status === "Not Evaluated"), true, "automated results are not manual conformance verdicts");
    const observations = report.pages[0].ruleOutcomes;
    assert.ok(observations.length >= 3, "each live state keeps automated rule observations");
    assert.ok(observations.flatMap((frame) => frame.rules).some((rule) => rule.status === "pass"));
    assert.equal(observations.every((frame) => frame.wcagVersion === config.audit.wcagVersion), true);
    assert.equal(JSON.stringify(observations).includes("leave-me-unchanged"), false, "passing observations must not include field data");
    assert.ok(events.findIndex((event) => event.type === "crawl-termination") > events.findIndex((event) => event.type === "state"));
  }
  // A browser closed mid-test must not drain the queue or start a replay pass,
  // and its checkpoint must not claim the scan completed.
  const cancellationEvents = [];
  const cancellationConfig = getConfig({ targetUrl, maxPages: 2, maxStates: 3, maxDepth: 1,
    headless: true, browserChannel: "bundled", login: false, aiEnabled: false,
    nvda: { requested: true }, nvdaSessionFactory: async () => ({
      async preparePage() {},
      async testState(page) { await page.close(); return { status: "blocked", actions: [] }; },
      finish() { return { product: "NVDA", actualExecution: false, status: "blocked", reason: "The test tab closed.", states: [] }; },
      async close() {}
    }) });
  cancellationConfig.reportsDir = path.join(reportsDir, "cancelled");
  await assert.rejects(runAccessibilityScan(cancellationConfig, (event) => cancellationEvents.push(event)), { code: "TEST_BROWSER_CLOSED" });
  const runId = cancellationEvents.find((event) => event.type === "report-started").reportId;
  const partial = JSON.parse(await fs.readFile(path.join(cancellationConfig.reportsDir, runId, "vpat_draft.json"), "utf8"));
  assert.equal(partial.status, "failed");
  assert.equal(partial.crawlTermination.reason, "test_browser_closed");
  assert.equal(partial.assistiveTechnology.actualRuns.NVDA.status, "blocked");
  assert.equal(cancellationEvents.some((event) => event.type === "complete"), false);

  // Recovery is a serialization barrier: neither a new state nor the next
  // route may be entered while the same live NVDA state is paused.
  for (const canRecover of [true, false]) {
    let readerState = "testing";
    let calls = 0;
    let resumes = 0;
    let closed = false;
    const recoveryEvents = [];
    const recoveryConfig = getConfig({ targetUrl, maxPages: 1, maxStates: 2, maxDepth: 1,
      headless: true, browserChannel: "bundled", login: false, aiEnabled: false,
      nvda: { requested: true }, nvdaSessionFactory: async () => ({
        async preparePage() {},
        get state() { return readerState; },
        get pausedReason() { return "Fixture focus loss"; },
        async testState(page, meta) {
          calls++;
          if (calls === 1) { readerState = "paused"; return { status: "interrupted", retryable: true, reason: "Fixture focus loss" }; }
          assert.equal(readerState, "testing");
          if (calls === 2) assert.equal(meta.state, "default", "retry the same state, not the next interaction");
          return { status: "executed", stateChanged: false };
        },
        async resume(page) {
          resumes++;
          assert.equal(recoveryEvents.some((event) => event.type === "state"), false, "the crawler must not advance during recovery");
          assert.equal(await page.locator("#panel").isVisible(), false);
          assert.equal(await page.locator("input").inputValue(), "leave-me-unchanged");
          if (canRecover) readerState = "testing";
          return canRecover;
        },
        finish() { return { product: "NVDA", status: canRecover ? "executed" : "interrupted", actualExecution: canRecover,
          reason: canRecover ? null : "Fixture focus loss", states: [{ state: "default", status: "interrupted", actions: [{ announcements: ["Preserved local evidence"] }] }] }; },
        async close() { closed = true; }
      }) });
    recoveryConfig.reportsDir = path.join(reportsDir, canRecover ? "resumed" : "interrupted");
    const recovered = await runAccessibilityScan(recoveryConfig, (event) => recoveryEvents.push(event));
    assert.equal(resumes, 1);
    assert.ok(closed);
    if (canRecover) {
      assert.equal(recovered.status, "complete");
      assert.ok(calls >= 3, "the next state is tested only after a successful same-state retry");
    } else {
      assert.equal(calls, 1);
      assert.equal(recovered.status, "stopped");
      assert.equal(recovered.stopReason.code, "NVDA_INTERRUPTED");
      assert.equal(recoveryEvents.some((event) => event.type === "state" || event.type === "complete"), false);
      assert.equal(recovered.assistiveTechnology.actualRuns.NVDA.status, "interrupted");
      assert.deepEqual(recovered.assistiveTechnology.actualRuns.NVDA.states[0].actions[0].announcements, ["Preserved local evidence"]);
      const saved = JSON.parse(await fs.readFile(path.join(recoveryConfig.reportsDir, recovered.id, "vpat_draft.json"), "utf8"));
      assert.equal(saved.status, "stopped");
    }
  }
  console.log("Shared general/financial engine, WCAG profiles, live same-page NVDA state hooks, rule observations, and mutation exclusions passed (mock NVDA adapter).");
} finally {
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(reportsDir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(reportsDir).startsWith("clarity-live-nvda-"));
  await fs.rm(reportsDir, { recursive: true, force: true });
}
