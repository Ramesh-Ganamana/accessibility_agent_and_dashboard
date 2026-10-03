import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:4173", { waitUntil: "networkidle" });

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

  await page.locator("#tab-crawl").click();
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

  console.log("Needs-review evidence, crawl graph, and VPAT/ACR tab visibility passed.");
} finally {
  await browser.close();
}
