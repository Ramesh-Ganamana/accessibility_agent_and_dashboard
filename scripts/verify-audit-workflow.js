import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { app, updateJobFromEvent } from "../src/server.js";
import { getConfig } from "../src/config.js";

const reportsRoot = getConfig().reportsDir;
await fs.mkdir(reportsRoot, { recursive: true });
const directory = await fs.mkdtemp(path.join(reportsRoot, "audit-workflow-fixture-"));
const id = path.basename(directory);
const report = {
  id, targetUrl: "https://financial-fixture.example", startedAt: "2026-10-10T00:00:00Z", completedAt: "2026-10-10T00:01:00Z",
  configuration: { audit: { profile: "financial", wcagVersion: "2.2", level: "AA" } },
  summary: { pagesScanned: 1, statesObserved: 1, confirmedIssues: 1, needsReview: 0, evidenceScreenshots: 0, durationMs: 60000, byImpact: { serious: 1 } },
  pages: [{ url: "https://financial-fixture.example", title: "Financial fixture", status: "scanned", issueIds: ["image-1"] }],
  graph: { nodes: [], edges: [] }, incomplete: [], events: [],
  issues: [{ id: "image-1", ruleId: "image-alt", wcag: ["1.1.1"], impact: "serious", help: "Image requires alternative text", pageUrl: "https://financial-fixture.example", target: ["#fixture"], state: "default", source: "axe-core" }]
};
const original = JSON.stringify(report);
await fs.writeFile(path.join(directory, "vpat_draft.json"), original);
const server = await new Promise((resolve, reject) => { const result = app.listen(0, "127.0.0.1", () => resolve(result)); result.once("error", reject); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const request = async (suffix, body) => {
    const response = await fetch(`${baseUrl}/api/reports/${id}${suffix}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    return { status: response.status, data: await response.json() };
  };
  const initial = await request("");
  assert.equal(initial.status, 200); assert.equal(initial.data.audit.criteria.length, 55);
  assert.equal(initial.data.audit.criteria.find((row) => row.id === "1.1.1").status, "Not Evaluated");
  const review = { kind: "criterion", targetId: "1.1.1", status: "Supports", reviewer: "Fixture reviewer", scope: "Chrome test build", notes: "Evidence reviewed", evidence: ["fixture-case-1"] };
  assert.equal((await request("/reviews", review)).status, 400, "confirmed scan findings must block a conflicting Supports decision");
  assert.equal((await request("/reviews", { ...review, status: "Does Not Support", evidence: [] })).status, 400);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/reports", (route) => route.fulfill({ json: [report] }));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#tab-vpat").click();
  await page.waitForFunction(() => document.querySelectorAll("#vpat-body tr").length === 55);
  assert.match(await page.locator("#audit-description").textContent(), /Financial application/);
  assert.ok(await page.locator('[data-check-id="financial-payments"]').count());
  await page.locator('[data-review-target="1.1.1"]').click();
  assert.equal(await page.locator('#audit-review-status option[value="Supports"]').evaluate((option) => option.disabled), true, await page.locator('#audit-review-form').textContent());
  await page.locator("#audit-review-status").selectOption("Does Not Support");
  await page.locator("#audit-review-reviewer").fill("Fixture reviewer");
  await page.locator("#audit-review-scope").fill("Fixture build, Chrome, default state only");
  await page.locator("#audit-review-notes").fill("<script>window.unsafeExecuted = true</script> Image label is missing.");
  await page.locator("#audit-review-evidence").fill("fixture-case-1\nevidence/fixture.png");
  if (process.env.AUDIT_PREVIEW_DIR) {
    await fs.mkdir(process.env.AUDIT_PREVIEW_DIR, { recursive: true });
    await page.locator("#audit-review-form").screenshot({ path: path.join(process.env.AUDIT_PREVIEW_DIR, "audit-review-form.png") });
  }
  await page.locator('#audit-review-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector("#audit-review-message").textContent.includes("Review entry saved"));
  assert.equal(await page.locator("#audit-review-form").isVisible(), false);
  assert.equal(await page.evaluate(() => window.unsafeExecuted), undefined);
  assert.equal(await page.locator("#audit-history li").count(), 1);
  const row = page.locator("#vpat-body tr").filter({ has: page.locator('[data-review-target="1.1.1"]') });
  assert.match(await row.textContent(), /Does Not Support/);
  for (const format of ["json", "csv", "html"]) {
    const response = await fetch(`${baseUrl}/api/reports/${id}/exports/${format}`);
    assert.equal(response.status, 200);
    const content = await response.text(); assert.match(content, /Does Not Support/);
    if (format === "html") assert.doesNotMatch(content, /<script>window\.unsafeExecuted/);
  }
  assert.equal(await fs.readFile(path.join(directory, "vpat_draft.json"), "utf8"), original);
  let scanPayload;
  await page.route("**/api/scans", async (route) => { scanPayload = route.request().postDataJSON(); await route.fulfill({ status: 400, json: { error: "Fixture: scan not started" } }); });
  for (const profile of ["general", "financial"]) {
    await page.locator("#target-url").fill("https://fixture.example");
    await page.locator("#audit-profile").selectOption(profile);
    await page.locator("#audit-version").selectOption("2.1");
    await page.locator('#scan-form button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('#scan-form button[type="submit"]').disabled);
    assert.deepEqual(scanPayload.audit, { profile, wcagVersion: "2.1", level: "AA" });
  }
  await page.locator("#tab-assistive").click();
  await page.evaluate(async (reportId) => {
    const { renderNvdaRun } = await import("/app.js");
    renderNvdaRun({ actualExecution: true, executionMode: "live-during-crawl", status: "executed", coverage: { statesExecuted: 1, statesAttempted: 1 }, states: [{ url: "https://fixture.example", state: "dialog:Details", executionMode: "live-during-crawl", status: "executed", evidence: "evidence/nvda/fixture.png", checks: { focus: { status: "executed", commands: 2 }, forms: { status: "manual-review", reason: "Inputs were not changed" } }, actions: [{ index: 1, command: "Tab", evidence: "evidence/nvda/fixture.png", announcements: ["Close button"] }] }] }, { id: reportId });
  }, id);
  assert.match(await page.locator("#nvda-run-title").textContent(), /during the headed crawl/);
  assert.equal(await page.locator("#nvda-checks > div").count(), 2);
  assert.equal(await page.locator("#nvda-run-evidence a").count(), 1, "same screenshot must be shown only once");
  const job = { progress: 43, warningCount: 0 }; updateJobFromEvent(job, { type: "nvda" }); updateJobFromEvent(job, { type: "nvda-complete" });
  assert.equal(job.progress, 43, "inline NVDA does not pretend the overall crawl is complete");
  assert.deepEqual(errors, []);
  console.log("General/financial settings, human evidence workflow, append-only history, API exports, live NVDA UI and progress checks passed.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(directory), path.resolve(reportsRoot));
  assert.ok(path.basename(directory).startsWith("audit-workflow-fixture-"));
  await fs.rm(directory, { recursive: true, force: true });
}
