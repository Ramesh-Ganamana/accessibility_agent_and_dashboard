import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startDashboardFixture } from "./helpers/dashboard-fixture.js";

const fixture = await startDashboardFixture();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let statusReads = 0;
  let scanPayload;
  let scanRequests = 0;
  let backendOffline = false;
  let startResponse = "accepted";
  await page.route("**/api/health", async (route) => {
    if (backendOffline) return route.abort("connectionrefused");
    await route.continue();
  });
  await page.route("**/api/scans", async (route) => {
    scanRequests += 1;
    scanPayload = route.request().postDataJSON();
    if (startResponse === "lost") return route.abort("connectionreset");
    if (startResponse === "rejected") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "The supplied application URL was rejected." }) });
    if (startResponse === "stopped") return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "job-ui-stopped", status: "queued", progress: 0, events: [] }) });
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "job-ui-status", status: "queued", progress: 0, events: [] }) });
  });
  await page.route("**/api/jobs/job-ui-status", async (route) => {
    statusReads += 1;
    if (statusReads === 2) {
      await route.abort("connectionreset");
      return;
    }
    const common = { id: "job-ui-status", startedAt: new Date(Date.now() - 4_000).toISOString(), currentUrl: "https://application.test/login", warningCount: 0 };
    const job = statusReads === 1
      ? { ...common, status: "running", phase: "Authentication", progress: 23, error: null, events: [{ at: new Date().toISOString(), type: "session", message: "Submitting the password and waiting for the application callback." }] }
      : { ...common, status: "failed", phase: "Failed", progress: 23, error: "The authentication callback did not finish.", events: [{ at: new Date().toISOString(), type: "failed", message: "The authentication callback did not finish." }] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job) });
  });

  await page.goto(fixture.baseUrl, { waitUntil: "networkidle" });
  await page.locator("#target-url").fill("https://application.test/");
  await page.getByRole("spinbutton", { name: "Page limit", exact: true }).fill("1");
  await page.getByRole("spinbutton", { name: "State limit", exact: true }).fill("12");
  await page.locator("#auth-enabled").check();
  await page.locator("#login-username").fill("fixture-user");
  await page.locator("#login-password").fill("fixture-password");
  backendOffline = true;
  await page.locator('#scan-form button[type="submit"]').click();
  await page.locator("#job-progress.failed").waitFor();
  assert.equal(scanRequests, 0, "an unavailable backend must be detected before sending scan data or credentials");
  assert.match(await page.locator("#job-status-label").textContent(), /backend disconnected/i);
  assert.match(await page.locator("#job-message").textContent(), /npm start/);
  assert.match(await page.locator("#job-detail").textContent(), /No scan request or credentials were sent/);
  assert.equal(await page.locator("#login-password").inputValue(), "fixture-password", "a preflight failure must not discard unsent form data");
  assert.equal(await page.locator('#scan-form button[type="submit"]').isDisabled(), false);
  backendOffline = false;
  await page.locator('#scan-form button[type="submit"]').click();

  await page.waitForFunction(() => document.querySelector("#job-percent").textContent === "23%");
  assert.equal(scanPayload.maxPages, 1, "single-page selection must be sent to the API");
  assert.equal(scanPayload.maxStates, 12, "interaction coverage must have its own budget");
  assert.equal(scanPayload.auth.emailSelector, "", "manual username selectors must stay optional");
  assert.equal(scanPayload.auth.passwordSelector, "", "manual password selectors must stay optional");
  assert.equal(scanPayload.auth.submitSelector, "", "manual submit selectors must stay optional");
  assert.equal(await page.locator("#login-password").inputValue(), "", "the UI must clear a password after transmission");
  assert.equal(await page.locator("#job-percent").textContent(), "23%");
  assert.match(await page.locator("#job-message").textContent(), /Submitting the password/);

  await page.locator("#job-progress.warning").waitFor();
  assert.match(await page.locator("#job-detail").textContent(), /may still be running; reconnecting/);
  assert.equal(await page.locator('#scan-form button[type="submit"]').isDisabled(), true, "a connection error must not allow launching a duplicate scan");
  assert.equal(await page.locator("#job-percent").textContent(), "23%", "connection loss must retain the last known progress");

  await page.locator("#job-progress.failed").waitFor({ timeout: 5_000 });
  assert.equal(await page.locator("#job-progress").getAttribute("role"), "region", "per-second progress updates must not repeatedly interrupt a screen reader");
  assert.equal(await page.locator("#job-alert").getAttribute("role"), "alert");
  assert.match(await page.locator("#job-alert").textContent(), /Scan failed.*did not finish/);
  assert.match(await page.locator("#job-message").textContent(), /did not finish/);
  assert.match(await page.locator("#job-detail").textContent(), /press Start scan to retry/);
  assert.equal(statusReads, 3, "polling must recover after a transient connection error");
  startResponse = "lost";
  await page.locator("#login-password").fill("fixture-password");
  await page.locator('#scan-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector("#job-status-label").textContent === "Scan start could not be confirmed");
  assert.match(await page.locator("#job-status-label").textContent(), /could not be confirmed/i);
  assert.match(await page.locator("#job-message").textContent(), /may have started/);
  assert.match(await page.locator("#job-detail").textContent(), /duplicate scan/);
  assert.equal(scanRequests, 2, "a lost POST response must never automatically resend the scan");
  startResponse = "rejected";
  await page.locator("#login-password").fill("fixture-password");
  await page.locator('#scan-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector("#job-message").textContent === "The supplied application URL was rejected.");
  assert.match(await page.locator("#job-message").textContent(), /supplied application URL was rejected/);
  assert.doesNotMatch(await page.locator("#job-message").textContent(), /may have started|locator/);

  // Closing the test browser ends a scan as "stopped": polling ends, the partial
  // report opens, submit is re-enabled and the saved report is labelled stopped.
  const stoppedReport = { ...structuredClone(fixture.reports[0]), id: "fixture-stopped", startedAt: "2026-01-01T13:00:00.000Z", completedAt: null, stoppedAt: "2026-01-01T13:00:40.000Z", status: "stopped",
    stopReason: { code: "TEST_BROWSER_CLOSED", message: "The test browser was closed." },
    externalTabs: [{ url: "https://partner.example/offer", source: "click", label: "Partner offer", reason: "external-origin" }, { url: "https://fixture.test/logout", source: "popup-sweep", label: "Sign out", reason: "unsafe" }] };
  stoppedReport.pages.push({ url: "https://fixture.test/help", title: "Help", depth: 1, openedInNewTab: true, issueIds: [], incompleteIds: [], observedStates: [] });
  fixture.reports.push(stoppedReport);
  let stoppedReads = 0;
  await page.route("**/api/jobs/job-ui-stopped", async (route) => {
    stoppedReads += 1;
    const at = new Date().toISOString();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      id: "job-ui-stopped", status: "stopped", phase: "Stopped — test browser closed; partial report saved", progress: 61, error: null, reportId: stoppedReport.id, stopReason: "The test browser was closed.",
      startedAt: new Date(Date.now() - 9_000).toISOString(), currentUrl: "https://fixture.test/", warningCount: 0,
      events: [{ at, type: "browser-closed", message: "The test browser was closed; the scan is stopping and keeps the results so far." }, { at, type: "stopped", message: "Scan stopped because the test browser was closed. The partial report was saved with 1 scanned page." }]
    }) });
  });
  startResponse = "stopped";
  await page.locator("#login-password").fill("fixture-password");
  await page.locator('#scan-form button[type="submit"]').click();
  await page.locator("#job-progress.stopped").waitFor();
  await page.waitForFunction(() => /^Stopped scan/.test(document.querySelector("#report-date").textContent));
  await page.waitForFunction(() => document.querySelector('#report-current option[value="fixture-stopped"]') && !document.querySelector('#scan-form button[type="submit"]').disabled);
  assert.match(await page.locator("#job-status-label").textContent(), /Scan stopped — partial report saved/);
  assert.equal(await page.locator("#job-status-icon").textContent(), "■");
  assert.equal(await page.locator("#job-percent").textContent(), "61%", "a stop keeps the last known progress");
  assert.match(await page.locator("#job-message").textContent(), /test browser was closed.*partial report was saved/);
  assert.match(await page.locator("#job-detail").textContent(), /report below/);
  assert.doesNotMatch(await page.locator("#job-detail").textContent(), /Correct the problem/, "closing the browser is not a problem to correct");
  assert.match(await page.locator("#job-announcer").textContent(), /Scan stopped: The test browser was closed\./, "a user-initiated stop is announced politely with its reason");
  assert.doesNotMatch(await page.locator("#job-alert").textContent(), /stopped/i);
  assert.equal(await page.locator('#scan-form button[type="submit"]').isDisabled(), false);
  assert.match(await page.locator("#report-date").textContent(), /^Stopped scan · partial results from 1 routes recorded before it stopped · The test browser was closed\.$/);
  assert.equal(await page.locator("#report-current").inputValue(), "fixture-stopped");
  assert.ok((await page.locator('#report-current option[value="fixture-stopped"]').textContent()).endsWith(" · stopped"), "the saved-report list labels a stopped scan");
  await page.locator("#tab-crawl").click();
  assert.equal(await page.locator("#tab-summary").isVisible(), true, "tabs the site opened are reported");
  assert.equal(await page.locator("#tab-summary-count").textContent(), "1 tested in place · 2 not tested");
  assert.deepEqual(await page.locator("#external-tabs-list li").allTextContents(), ["Partner offerhttps://partner.example/offerExternal origin · Source: Click", "Sign outhttps://fixture.test/logoutUnsafe · Source: Popup sweep"]);
  assert.equal(await page.locator("#external-tabs-list a").count(), 0, "untested tab addresses are never links");

  // NVDA pauses, recoveries and the stop reason are shown in the NVDA panel.
  const nvdaPanel = await page.evaluate(async () => {
    const { renderNvdaRun } = await import("/app.js");
    const reason = "NVDA could not be resumed after 3 recoveries.";
    renderNvdaRun({ actualExecution: true, status: "executed", outcome: "completed-with-warnings", executionMode: "after-crawl", coverage: { statesAttempted: 2, statesExecuted: 1 }, states: [],
      pauses: [{ at: "2026-01-01T13:00:10.000Z", reason: "Focus moved to another tab.", source: "watch-tab", resumedAt: "2026-01-01T13:00:12.000Z", outcome: "resumed" },
        { at: "2026-01-01T13:00:20.000Z", reason: "Windows Settings took focus.", source: "addon", resumedAt: null, outcome: "stopped" }],
      recoveries: 1, stoppedReason: reason, stopKind: "recovery-exhausted", warnings: [reason], limitations: [] }, { id: "fixture-stopped" });
    return { summary: document.querySelector("#nvda-run-summary").textContent, notes: [...document.querySelectorAll("#nvda-run-notes li")].map((item) => item.textContent) };
  });
  assert.match(nvdaPanel.summary, /NVDA stopped before finishing \(recovery exhausted\): NVDA could not be resumed/);
  assert.ok(nvdaPanel.notes.some((note) => /paused 2 times when focus left the test tab and resumed 1; 1 unexpected recovery used/.test(note)), nvdaPanel.notes.join("\n"));
  assert.ok(nvdaPanel.notes.some((note) => /^Pause 1 at .+: Focus moved to another tab\. · resumed at /.test(note)));
  assert.ok(nvdaPanel.notes.some((note) => /^Pause 2 at .+: Windows Settings took focus\. · Stopped$/.test(note)));
  assert.equal(nvdaPanel.notes.filter((note) => /could not be resumed/.test(note)).length, 0, "the stop reason is shown once, in the summary");

  const interruptedPanel = await page.evaluate(async () => {
    const { renderNvdaRun } = await import("/app.js");
    renderNvdaRun({ started: true, actualExecution: false, status: "interrupted", outcome: "interrupted", reason: "The testing tab lost focus.",
      executionMode: "live-during-crawl", coverage: { statesAttempted: 1, statesExecuted: 0, statesInterrupted: 1 },
      states: [{ state: "default", url: "https://fixture.test/", status: "interrupted", error: "Remaining checks were not completed.",
        actions: [{ index: 1, command: "Read available content to end", status: "blocked", outcome: "needs-review", readingCompletion: "interrupted", announcements: ["Retained partial announcement"] }] }]
    }, { id: "fixture-interrupted" });
    return { summary: document.querySelector("#nvda-run-summary").textContent,
      transcript: document.querySelector("#nvda-transcript-list").textContent,
      label: document.querySelector("#nvda-state-select").selectedOptions[0].textContent };
  });
  assert.match(interruptedPanel.summary, /NVDA started, but testing was interrupted/);
  assert.doesNotMatch(interruptedPanel.summary, /requested but not executed/);
  assert.match(interruptedPanel.transcript, /Retained partial announcement/);
  assert.match(interruptedPanel.label, /Interrupted/);

  const requiredPanel = await page.evaluate(async () => {
    const { renderNvdaRun } = await import("/app.js");
    renderNvdaRun({ actualExecution: true, status: "executed", outcome: "needs-review", executionMode: "live-during-crawl",
      coverage: { statesAttempted: 1, statesExecuted: 1 }, states: [{ state: "default", status: "executed", url: "https://fixture.test/",
        checks: { requiredFields: { status: "needs-review", commands: 1, reason: "Only reached focus stops are checked." } },
        actions: [{ index: 1, kind: "focus", command: "Tab", status: "executed", outcome: "needs-review", announcements: ["Email star edit"],
          focus: { tag: "input", name: "Email *" }, requiredFieldCheck: { status: "needs-review", expectation: "possible",
            sources: ["Associated asterisk"], reason: "An associated asterisk was found, but its required-field meaning was not established." } }] }]
    }, { id: "fixture-required" });
    return { transcript: document.querySelector("#nvda-transcript-list").textContent, checks: document.querySelector("#nvda-checks").textContent };
  });
  assert.match(requiredPanel.transcript, /Email star edit/);
  assert.match(requiredPanel.transcript, /Required-field check: Needs review/);
  assert.match(requiredPanel.transcript, /Detected indicators: Associated asterisk/);
  assert.match(requiredPanel.checks, /Required fields/);
  assert.match(requiredPanel.checks, /Only reached focus stops/);

  await page.waitForTimeout(2_500);
  assert.equal(stoppedReads, 1, "polling must stop at a stopped scan");
  console.log("Backend preflight, optional login selectors, uncertain start handling, live progress, connection recovery and stopped-scan UI passed.");
} finally {
  await browser?.close();
  await fixture.close();
}
