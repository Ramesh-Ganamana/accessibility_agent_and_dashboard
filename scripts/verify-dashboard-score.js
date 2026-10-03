import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const reports = await page.request.get(`${baseUrl}/api/reports`).then((response) => response.json());
  const selected = reports.find((report) => report.completedAt && report.summary?.pagesScanned > 0);
  assert.ok(selected, "A completed report with scanned pages is required for dashboard verification.");
  const reportBase = `${baseUrl}/api/reports/${encodeURIComponent(selected.id)}`;
  const scoreResponse = await page.request.get(`${reportBase}/score`);
  assert.equal(scoreResponse.status(), 200);
  const score = await scoreResponse.json();
  assert.equal(score.outOf, 10);
  assert.equal(score.status, "provisional");
  assert.ok(Number.isFinite(score.score));
  assert.equal(score.principles.length, 4);
  for (const section of ["overview", "issues", "pages", "graph", "activity", "acr", "evidence"]) {
    const response = await page.request.get(`${reportBase}/${section}`);
    assert.equal(response.status(), 200, `${section} dashboard endpoint must be available`);
  }
  const overview = await page.request.get(`${reportBase}/overview`).then((response) => response.json());
  assert.equal(overview.assessment.score, score.score);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#report-current").selectOption(selected.id);
  await page.waitForFunction((expected) => document.querySelector("#health-score-value")?.textContent === expected, score.score.toFixed(1));
  assert.match(await page.locator("#health-grade").textContent(), /Grade .* Provisional/);
  assert.equal(await page.locator(".health-principle-row").count(), 4);
  assert.match(await page.locator("#health-method-text").textContent(), /not a WCAG conformance score/i);
  if (process.env.DASHBOARD_SCREENSHOT) await page.screenshot({ path: process.env.DASHBOARD_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator(".health-stage").isVisible(), true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `mobile dashboard should not scroll horizontally (${overflow}px overflow)`);
  if (process.env.DASHBOARD_MOBILE_SCREENSHOT) await page.screenshot({ path: process.env.DASHBOARD_MOBILE_SCREENSHOT, fullPage: true });
  console.log("Dashboard score, methodology, four principles, and all report-section endpoints passed.");
} finally {
  await browser.close();
}
