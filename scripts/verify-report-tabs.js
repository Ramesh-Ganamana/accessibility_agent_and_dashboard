import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startDashboardFixture } from "./helpers/dashboard-fixture.js";

const fixture = await startDashboardFixture();
fixture.reports[0].crawlTermination = {
  reason: "page_limit_reached",
  message: "Crawl reached the configured 1-page limit after inspecting 3 page and interaction states, with 2 eligible routes remaining."
};
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(fixture.baseUrl, { waitUntil: "networkidle" });

  await page.locator("#tab-issues").click();
  await page.locator("#finding-status-filter").selectOption("needs-review");
  const reviewCards = page.locator("#issue-list .issue-item");
  assert.ok(await reviewCards.count() > 0, "needs-review filter should show uncertain findings");
  await reviewCards.first().click();
  const reviewState = await page.evaluate(() => ({
    chip: document.querySelector("#issue-list .issue-item.selected .wcag-chip")?.textContent?.trim(),
    status: document.querySelector("#evidence-review-status")?.textContent?.trim(),
    historyHidden: document.querySelector("#review-history-block")?.hidden,
    historyItems: document.querySelectorAll("#review-history li").length,
    frameHidden: document.querySelector("#screenshot-frame")?.hidden,
    imageHidden: document.querySelector("#evidence-image")?.hidden,
    removedEmptyState: document.querySelector("#no-evidence") === null
  }));
  assert.equal(reviewState.chip, "NEEDS REVIEW");
  assert.equal(reviewState.status, "Human decision pending");
  assert.equal(reviewState.historyHidden, false);
  assert.ok(reviewState.historyItems > 0, "needs-review finding should explain its review history");
  assert.equal(reviewState.removedEmptyState, true, "the obsolete no-visible-bounding-box panel should be removed");
  assert.equal(reviewState.frameHidden, false, "review finding with evidence should show its screenshot frame");
  assert.equal(reviewState.imageHidden, false, "review finding with evidence should show its screenshot");
  await page.locator("#issue-search").fill("a finding that does not exist");
  assert.equal(await page.locator("#screenshot-frame").isVisible(), false, "empty filters must clear stale screenshots");
  assert.equal(await page.locator("#evidence-target").textContent(), "—");
  await page.locator("#issue-search").fill("");
  await page.locator("#finding-status-filter").selectOption("all");

  await page.locator("#tab-crawl").click();
  assert.equal(await page.locator("#crawl-coverage-note").isVisible(), true);
  assert.match(await page.locator("#crawl-coverage-note").textContent(), /1-page limit.*3 page and interaction states.*2 eligible routes/);
  const crawlState = await page.evaluate(() => ({
    issuesHidden: document.querySelector("#panel-issues").hidden,
    issuesDisplay: getComputedStyle(document.querySelector("#panel-issues")).display,
    crawlHidden: document.querySelector("#panel-crawl").hidden,
    crawlDisplay: getComputedStyle(document.querySelector("#panel-crawl")).display,
    nodes: document.querySelectorAll("#crawl-graph .graph-node").length,
    arrows: document.querySelectorAll("#crawl-graph .graph-edge[marker-end]").length,
    actionLabels: document.querySelectorAll("#crawl-graph .graph-edge-label").length
  }));
  assert.equal(crawlState.issuesHidden, true);
  assert.equal(crawlState.issuesDisplay, "none");
  assert.equal(crawlState.crawlHidden, false);
  assert.notEqual(crawlState.crawlDisplay, "none");
  assert.ok(crawlState.nodes > 0, "crawl graph should contain at least one page node");
  assert.ok(crawlState.arrows > 0, "crawl graph should contain directional action arrows");
  assert.equal(crawlState.actionLabels, crawlState.arrows, "every action arrow should have a label");
  await page.locator('#crawl-graph .graph-node[aria-label^="Account,"]').click();
  assert.equal(await page.locator("#issue-list .issue-item").count(), 1, "a dialog node must show only its state findings");
  assert.equal(await page.locator("#evidence-state").textContent(), "dialog:Account");
  await page.locator("#tab-crawl").click();
  await page.locator('#crawl-graph .graph-node[aria-label^="Help,"]').click();
  assert.equal(await page.locator("#issue-list .issue-item").count(), 1, "same-route states must remain independently selectable");
  assert.equal(await page.locator("#evidence-state").textContent(), "dialog:Help");
  await page.locator("#tab-crawl").click();
  await page.locator('#crawl-graph .graph-node[aria-label^="Help,"]').click();
  await page.locator("#tab-issues").click();
  assert.equal(await page.locator("#issue-list .issue-item").count(), 5, "clearing graph selection must refresh all findings");

  await page.locator("#tab-assistive").click();
  const assistiveState = await page.evaluate(() => ({
    panelHidden: document.querySelector("#panel-assistive").hidden,
    panelDisplay: getComputedStyle(document.querySelector("#panel-assistive")).display,
    nvda: document.querySelector("#at-nvda")?.textContent?.trim(),
    jaws: document.querySelector("#at-jaws")?.textContent?.trim(),
    disclaimer: document.querySelector("#assistive-disclaimer")?.textContent || "",
    selectorOptions: document.querySelectorAll("#assistive-state-select option").length
  }));
  assert.equal(assistiveState.panelHidden, false);
  assert.notEqual(assistiveState.panelDisplay, "none");
  assert.equal(assistiveState.nvda, "Not run");
  assert.equal(assistiveState.jaws, "Not run");
  assert.match(assistiveState.disclaimer, /No actual screen-reader execution|not (?:a )?(?:test )?run with NVDA/i);
  assert.ok(assistiveState.selectorOptions > 0);

  const nvdaRunState = await page.evaluate(async () => {
    const { renderNvdaRun } = await import("/app.js");
    renderNvdaRun({
      actualExecution: true,
      status: "executed",
      outcome: "completed-with-warnings",
      version: "state-test-version",
      coverage: { statesDiscovered: 4, statesSelected: 3, statesAttempted: 3, statesExecuted: 2, statesSkippedByLimit: 1, keyboardCommands: 2, announcementsCaptured: 2 },
      states: [{
        id: "base", stateId: "base", state: "default", url: "https://example.test/", status: "executed", evidence: "evidence/nvda/base.png",
        actions: [{ index: 1, command: "Tab", announcements: ["Open account button"], focus: { tag: "button", name: "Open account" } }]
      }, {
        id: "account", stateId: "account", state: "dialog:Account", url: "https://example.test/", status: "executed", evidence: "evidence/nvda/account.png",
        actions: [{ index: 1, command: "Tab", announcements: ["Account name edit"], focus: { tag: "input", name: "Account name" } }]
      }, {
        id: "help", stateId: "help", state: "dialog:Help", url: "https://example.test/", status: "error", actions: [], error: "Help dialog could not be restored."
      }],
      // State results take precedence even when a historical field is also present.
      pages: [{ url: "https://example.test/", status: "executed", actions: [] }],
      warnings: [], limitations: ["Human NVDA task testing is still required."]
    }, { id: "fixture-current" });
    return {
      hidden: document.querySelector("#nvda-run-panel").hidden,
      version: document.querySelector("#nvda-run-version").textContent,
      states: document.querySelector("#nvda-run-states").textContent,
      options: [...document.querySelectorAll("#nvda-state-select option")].map((option) => option.textContent),
      label: document.querySelector("#nvda-state-picker-label").textContent,
      summary: document.querySelector("#nvda-run-summary").textContent,
      notes: document.querySelector("#nvda-run-notes").textContent
    };
  });
  assert.equal(nvdaRunState.hidden, false);
  assert.equal(nvdaRunState.version, "state-test-version");
  assert.equal(nvdaRunState.states, "2 / 3");
  assert.equal(nvdaRunState.label, "Tested state");
  assert.equal(nvdaRunState.options.length, 3, "same-URL states must appear as separate NVDA results");
  assert.match(nvdaRunState.options[1], /dialog:Account.*account/);
  assert.match(nvdaRunState.options[2], /dialog:Help.*Error/);
  assert.doesNotMatch(nvdaRunState.summary, /Legacy/);
  assert.match(nvdaRunState.notes, /3 selected from 4 discovered states/);
  assert.match(nvdaRunState.notes, /1 state was not selected/);
  assert.match(await page.locator("#nvda-run-evidence a").getAttribute("href"), /\/base\.png$/);
  await page.locator("#nvda-state-select").selectOption("1");
  assert.equal(await page.locator("#nvda-transcript-list strong").textContent(), "Account name edit");
  assert.match(await page.locator("#nvda-run-evidence a").getAttribute("href"), /\/account\.png$/);
  await page.locator("#nvda-state-select").selectOption("2");
  assert.equal(await page.locator("#nvda-transcript-list").textContent(), "Help dialog could not be restored.");
  assert.equal(await page.locator("#nvda-run-evidence a").count(), 0, "failed state must clear the preceding state evidence");

  const legacyNvdaRun = await page.evaluate(async () => {
    const { renderNvdaRun } = await import("/app.js");
    renderNvdaRun({
      actualExecution: true,
      status: "executed",
      outcome: "completed",
      version: "test-version",
      coverage: { pagesAttempted: 1, pagesExecuted: 1, keyboardCommands: 1, announcementsCaptured: 1 },
      pages: [{
        url: "https://example.test/",
        status: "executed",
        actions: [{ index: 1, command: "Tab", announcements: ["Example link"], focus: { tag: "a", name: "Example" } }]
      }],
      warnings: [],
      limitations: ["Test fixture limitation"]
    }, { id: "demo" });
    return {
      hidden: document.querySelector("#nvda-run-panel").hidden,
      version: document.querySelector("#nvda-run-version").textContent,
      announcement: document.querySelector("#nvda-transcript-list strong")?.textContent,
      states: document.querySelector("#nvda-run-states").textContent,
      label: document.querySelector("#nvda-state-picker-label").textContent,
      summary: document.querySelector("#nvda-run-summary").textContent,
      notes: document.querySelector("#nvda-run-notes").textContent
    };
  });
  assert.equal(legacyNvdaRun.hidden, false);
  assert.equal(legacyNvdaRun.version, "test-version");
  assert.equal(legacyNvdaRun.announcement, "Example link");
  assert.equal(legacyNvdaRun.states, "Not recorded", "legacy page counts must not become state coverage");
  assert.equal(legacyNvdaRun.label, "Legacy tested page");
  assert.match(legacyNvdaRun.summary, /Legacy page-only run.*Interaction-state coverage was not recorded/);
  assert.match(legacyNvdaRun.notes, /1 of 1 pages executed/);
  assert.match(legacyNvdaRun.notes, /Test fixture limitation/);

  await page.evaluate(async () => {
    const { renderNvdaRun } = await import("/app.js");
    renderNvdaRun({ actualExecution: false, status: "not-run", reason: "No replayable states.", states: [], pages: [{ url: "https://example.test/", actions: [] }] }, { id: "demo" });
  });
  assert.equal(await page.locator("#nvda-state-select").isDisabled(), true);
  assert.equal(await page.locator("#nvda-state-select option").textContent(), "No NVDA state result", "an empty state run must not silently fall back to pages");
  assert.match(await page.locator("#nvda-run-summary").textContent(), /No replayable states/);
  assert.doesNotMatch(await page.locator("#nvda-run-summary").textContent(), /Legacy/);
  assert.equal(await page.locator("#nvda-transcript-list").textContent(), "No actual NVDA transcript was captured.");
  await page.evaluate(async () => {
    const { renderNvdaRun } = await import("/app.js");
    renderNvdaRun(null, { id: "demo" });
  });
  assert.equal(await page.locator("#nvda-run-panel").isVisible(), false);

  await page.locator("#tab-vpat").click();
  const vpatState = await page.evaluate(() => ({
    issuesHidden: document.querySelector("#panel-issues").hidden,
    issuesDisplay: getComputedStyle(document.querySelector("#panel-issues")).display,
    vpatHidden: document.querySelector("#panel-vpat").hidden,
    vpatDisplay: getComputedStyle(document.querySelector("#panel-vpat")).display,
    rows: document.querySelectorAll("#vpat-body tr").length
  }));
  assert.equal(vpatState.issuesHidden, true);
  assert.equal(vpatState.issuesDisplay, "none");
  assert.equal(vpatState.vpatHidden, false);
  assert.notEqual(vpatState.vpatDisplay, "none");
  assert.ok(vpatState.rows > 0, "VPAT/ACR should contain at least one criterion row");

  await page.route("**/api/reports/fixture-earlier", (route) => route.fulfill({ status: 500, json: { error: "Fixture read failed" } }));
  await page.locator("#report-current").selectOption("fixture-earlier");
  await page.locator("#report-toast").waitFor({ state: "visible" });
  assert.match(await page.locator("#report-toast").textContent(), /Fixture read failed/);
  await page.locator("#report-current").selectOption("fixture-empty");
  await page.waitForFunction(() => document.querySelector("#report-domain").textContent === "empty.test");
  await page.locator("#tab-issues").click();
  assert.equal(await page.locator("#screenshot-frame").isVisible(), false, "a report without findings must not display the previous report screenshot");
  assert.equal(await page.locator("#evidence-target").textContent(), "—");
  assert.match(await page.locator("#report-date").textContent(), /0 routes · 0 states/);
  assert.equal(await page.locator("#report-toast").isVisible(), false);

  console.log("Needs-review evidence, crawl graph, screen-reader readiness, and VPAT/ACR tab visibility passed.");
} finally {
  await browser?.close();
  await fixture.close();
}
