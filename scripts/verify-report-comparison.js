import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const listResponse = await page.request.get(`${baseUrl}/api/reports`);
  assert.equal(listResponse.status(), 200);
  const reports = await listResponse.json();
  const latest = reports.find((report) => report.completedAt && reports.some((older) => older.completedAt && older.targetUrl === report.targetUrl && older.startedAt < report.startedAt));
  assert.ok(latest, "fixture history needs two completed reports from one application");
  const older = reports.find((report) => report.completedAt && report.targetUrl === latest.targetUrl && report.startedAt < latest.startedAt);
  const other = reports.find((report) => new URL(report.targetUrl).hostname !== new URL(latest.targetUrl).hostname &&
    reports.some((olderRun) => olderRun.completedAt && new URL(olderRun.targetUrl).hostname === new URL(report.targetUrl).hostname && olderRun.startedAt < report.startedAt));
  assert.ok(other, "fixture history needs two reports from a different application for the reset check");
  const otherOlder = reports.find((report) => report.completedAt && new URL(report.targetUrl).hostname === new URL(other.targetUrl).hostname && report.startedAt < other.startedAt);

  const forbidden = await page.request.get(`${baseUrl}/api/reports/${latest.id}/compare/${other.id}`);
  assert.equal(forbidden.status(), 409);
  assert.match((await forbidden.json()).error, /Cross-site report comparison is not allowed/);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#report-current").selectOption(latest.id);
  await page.waitForFunction((id) => document.querySelector("#report-current")?.value === id, latest.id);
  await page.locator("#open-comparison").click();
  assert.equal(await page.locator(".hero").isVisible(), false);
  assert.equal(await page.locator("#report-shell").isVisible(), false);
  assert.equal(await page.locator("#comparison-shell").isVisible(), true);
  assert.equal(await page.locator("#comparison-module").isVisible(), false, "choosing reports must not auto-run a comparison");
  // Selecting the newest scan first must still leave older same-site scans usable.
  await page.locator("#compare-before").selectOption(latest.id);
  assert.equal(await page.locator(`#compare-after option[value="${other.id}"]`).evaluate((option) => option.disabled), true);
  assert.equal(await page.locator(`#compare-after option[value="${older.id}"]`).evaluate((option) => option.disabled), false);
  await page.locator("#compare-after").selectOption(older.id);
  assert.equal(await page.locator("#comparison-module").isVisible(), false);
  await page.locator("#compare-run").click();
  await page.locator("#comparison-module").waitFor({ state: "visible" });
  const comparison = await page.request.get(`${baseUrl}/api/reports/${latest.id}/compare/${older.id}`).then((response) => response.json());
  assert.equal(Number(await page.locator("#comparison-new-badge").textContent()), comparison.counts.new);
  assert.equal(Number(await page.locator("#comparison-fixed-badge").textContent()), comparison.counts.fixed);
  assert.equal(Number(await page.locator("#comparison-unresolved-badge").textContent()), comparison.counts.unresolved);
  assert.ok(await page.locator("#comparison-table-body tr").count() > 0);
  const findings = ["new", "fixed", "unresolved"].flatMap((group) => comparison.groups[group].map((finding) => ({ group, finding })));
  const captureIndex = findings.findIndex(({ group, finding }) => group === "fixed" ? finding.evidence?.url : finding.evidence?.url || finding.previousEvidence?.url);
  assert.ok(captureIndex >= 0, "fixture comparison needs at least one saved screenshot");
  await page.locator("#comparison-table-body .comparison-evidence-select").nth(captureIndex).click();
  assert.equal(await page.locator("#comparison-evidence").isVisible(), true);
  const screenshotUrl = findings[captureIndex].group === "fixed" ? findings[captureIndex].finding.evidence.url : findings[captureIndex].finding.evidence?.url || findings[captureIndex].finding.previousEvidence.url;
  const screenshotResponse = await page.request.get(`${baseUrl}${screenshotUrl}`);
  assert.equal(screenshotResponse.status(), 200, "comparison screenshot should resolve to the saved report image");
  assert.ok(await page.locator("#comparison-evidence img").count() > 0);
  assert.ok(await page.locator("#compare-before-graph .comparison-graph-node").count() > 0, "earlier run must have its own crawl graph");
  assert.ok(await page.locator("#compare-after-graph .comparison-graph-node").count() > 0, "later run must have its own crawl graph");
  assert.equal(await page.locator("#crawl-graph").isVisible(), false, "single-report crawl graph must stay outside the comparison dashboard");
  await page.locator('[data-comparison-filter="unresolved"]').click();
  assert.equal(await page.locator('[data-comparison-filter="unresolved"]').getAttribute("aria-pressed"), "true");
  assert.match(await page.locator("#comparison-caveat").textContent(), /not proof/);
  await page.setViewportSize({ width: 390, height: 844 });
  const earlierCard = await page.locator(".comparison-graph-card").first().boundingBox();
  const laterCard = await page.locator(".comparison-graph-card").last().boundingBox();
  assert.ok(laterCard.y > earlierCard.y, "comparison crawl graphs should stack on narrow screens");
  await page.locator("#compare-before").selectOption("");
  await page.locator("#compare-after").selectOption("");
  await page.locator("#compare-before").selectOption(older.id);
  await page.locator("#compare-after").selectOption(latest.id);
  await page.locator("#compare-run").click();
  await page.locator("#comparison-module").waitFor({ state: "visible" });
  assert.equal(Number(await page.locator("#comparison-new-badge").textContent()), comparison.counts.new,
    "the same result should appear when reports are selected in chronological order");
  await page.locator("#compare-reset").click();
  assert.equal(await page.locator("#compare-before").inputValue(), "");
  assert.equal(await page.locator("#compare-after").inputValue(), "");
  assert.equal(await page.locator("#comparison-module").isVisible(), false);
  assert.equal(await page.locator(`#compare-before option[value="${other.id}"]`).evaluate((option) => option.disabled), false,
    "reset should make reports from another application available again");
  await page.locator("#compare-before").selectOption(other.id);
  await page.locator("#compare-after").selectOption(otherOlder.id);
  await page.locator("#compare-run").click();
  await page.locator("#comparison-module").waitFor({ state: "visible" });
  assert.ok((await page.locator("#comparison-dates").textContent()).includes(new URL(other.targetUrl).hostname));
  await page.locator("#back-to-report").click();
  assert.equal(await page.locator(".hero").isVisible(), true);
  assert.equal(await page.locator("#report-shell").isVisible(), true);
  assert.equal(await page.locator("#comparison-shell").isVisible(), false);
  console.log("Dedicated report comparison dashboard, reset across applications, saved evidence screenshots, separate crawl graphs, delta filters, and cross-site guard passed.");
} finally {
  await browser.close();
}
