import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { app } from "../src/server.js";
import { getConfig } from "../src/config.js";

const reportsRoot = path.resolve(getConfig().reportsDir);
await fs.mkdir(reportsRoot, { recursive: true });
const fixtureDirectories = [];
const makeReport = async (profile) => {
  const directory = await fs.mkdtemp(path.join(reportsRoot, "financial-workflow-fixture-"));
  fixtureDirectories.push(directory);
  const report = {
    id: path.basename(directory), targetUrl: "https://financial-fixture.example", startedAt: "2026-10-11T00:00:00Z", completedAt: "2026-10-11T00:01:00Z",
    configuration: { audit: { profile, wcagVersion: "2.2", level: "AA" } },
    summary: { pagesScanned: 1, statesObserved: 1, confirmedIssues: 1, needsReview: 1, evidenceScreenshots: 0, durationMs: 60000, byImpact: { serious: 1 } },
    pages: [{ url: "https://financial-fixture.example", title: "Synthetic financial fixture", status: "scanned", issueIds: ["confirmed-1"] }],
    graph: { nodes: [], edges: [] }, events: [],
    issues: [{ id: "confirmed-1", ruleId: "image-alt", wcag: ["1.1.1"], impact: "serious", help: "Synthetic missing alternative", pageUrl: "https://financial-fixture.example", target: ["#fixture"], state: "default", source: "axe-core" }],
    incomplete: [{ id: "uncertain-1", ruleId: "color-contrast", wcag: ["1.4.3"], impact: "serious", help: "Synthetic uncertain contrast", pageUrl: "https://financial-fixture.example", target: ["#uncertain"], state: "default", source: "axe-core", reviewStatus: "needs-review" }]
  };
  const original = JSON.stringify(report);
  await fs.writeFile(path.join(directory, "vpat_draft.json"), original);
  return { report, directory, original };
};

let server;
let browser;
try {
  const financial = await makeReport("financial");
  const general = await makeReport("general");
  server = await new Promise((resolve, reject) => { const result = app.listen(0, "127.0.0.1", () => resolve(result)); result.once("error", reject); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (id, suffix = "", body) => {
    const response = await fetch(`${baseUrl}/api/reports/${id}${suffix}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    return { status: response.status, data: await response.json() };
  };
  const initial = await request(financial.report.id);
  assert.equal(initial.status, 200);
  assert.equal(initial.data.audit.financial.summary.stepsTotal, 32);
  assert.equal(initial.data.audit.financial.summary.journeysTotal, 8);
  assert.equal(initial.data.audit.financial.summary.pending, 32);
  assert.equal(initial.data.audit.financial.professionalExperience, "not-established");
  assert.equal((await request(financial.report.id, "/financial")).data.summary.stepsTotal, 32);
  assert.equal((await request(general.report.id, "/financial")).data, null);
  assert.equal((await request(general.report.id)).data.audit.financial, null);
  const step = initial.data.audit.financial.journeys.flatMap((journey) => journey.steps).find((entry) => entry.requiresSandbox);
  const review = {
    kind: "financial-step", targetId: step.id, status: "pass", reviewer: "Synthetic reviewer", scope: "Synthetic test build and sandbox only",
    notes: "Synthetic evidence for integration verification, not a client audit.", evidence: ["fixture-case-only"],
    execution: { environment: "sandbox", applicationVersion: "fixture-build-1", browser: "Chromium fixture / Windows", assistiveTechnology: "Keyboard-only fixture", authorizationRef: "synthetic-test-plan" }, findingIds: []
  };
  assert.equal((await request(financial.report.id, "/reviews", { ...review, execution: { ...review.execution, environment: "production-read-only" } })).status, 400, "consequential production pass must be rejected");
  assert.equal((await request(financial.report.id, "/reviews", { ...review, findingIds: ["not-a-real-finding"] })).status, 400);
  assert.equal((await request(financial.report.id, "/reviews", { ...review, findingIds: ["confirmed-1"] })).status, 400, "confirmed failures cannot be linked to a pass");
  assert.equal((await request(general.report.id, "/reviews", review)).status, 400, "general profile must not accept financial steps");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/reports", (route) => route.fulfill({ json: [financial.report, general.report] }));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#tab-vpat").click();
  await page.locator("#financial-review-workspace").waitFor({ state: "visible" });
  assert.equal(await page.locator("#financial-journeys .financial-step").count(), 32);
  assert.match(await page.locator("#financial-completion-notice").textContent(), /self-reported/);
  assert.match(await page.locator("#financial-review-workspace").textContent(), /not established/);
  const openStep = async () => {
    const card = page.locator(`[data-step-id="${step.id}"]`);
    await card.locator("xpath=ancestor::details[contains(@class, 'financial-journey')]").evaluate((details) => { details.open = true; });
    await card.getByRole("button", { name: `Record scenario review: ${step.title}`, exact: true }).click();
    return card;
  };
  const fillReview = async (status, environment, note) => {
    await page.locator("#audit-review-status").selectOption(status);
    await page.locator("#audit-review-reviewer").fill(review.reviewer);
    await page.locator("#audit-review-scope").fill(review.scope);
    await page.locator("#audit-review-notes").fill(note);
    await page.locator("#audit-review-evidence").fill(review.evidence.join("\n"));
    await page.locator("#audit-execution-environment").selectOption(environment);
    await page.locator("#audit-execution-version").fill(review.execution.applicationVersion);
    await page.locator("#audit-execution-browser").fill(review.execution.browser);
    await page.locator("#audit-execution-at").fill(review.execution.assistiveTechnology);
    await page.locator("#audit-execution-authorization").fill(review.execution.authorizationRef);
  };
  const saveReview = async () => {
    await page.locator('#audit-review-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#audit-review-message").textContent.includes("Review entry saved"));
  };
  await openStep();
  assert.equal(await page.locator("#audit-financial-findings input").count(), 2);
  await fillReview("blocked", "production-read-only", "<script>window.financialUnsafe = true</script> No authorized sandbox is available.");
  await page.locator('#audit-financial-findings input[value="uncertain-1"]').check();
  assert.equal(await page.locator(".skip-link").evaluate((node) => document.activeElement !== node && node.getBoundingClientRect().bottom < 0), true, "unfocused skip link must remain offscreen");
  if (process.env.AUDIT_PREVIEW_DIR) {
    await fs.mkdir(process.env.AUDIT_PREVIEW_DIR, { recursive: true });
    await page.locator("#audit-review-form").screenshot({ path: path.join(process.env.AUDIT_PREVIEW_DIR, "financial-review-form.png") });
  }
  await saveReview();
  let saved = (await request(financial.report.id)).data;
  assert.equal(saved.audit.financial.summary.blocked, 1);
  assert.equal(saved.audit.financial.summary.stepsReviewed, 1);
  assert.equal(saved.audit.financial.summary.pending, 31);
  assert.equal(saved.audit.reviews.length, 1);
  assert.deepEqual(saved.audit.reviews[0].findingIds, ["uncertain-1"]);
  assert.equal(saved.audit.reviews[0].execution.environment, "production-read-only");
  assert.equal(saved.audit.criteria.find((entry) => entry.id === "1.1.1").status, "Not Evaluated", "scenario review must not establish WCAG support");
  assert.equal(await page.evaluate(() => window.financialUnsafe), undefined);
  assert.match(await page.locator("#audit-history").textContent(), /production read only/i);

  await openStep();
  await fillReview("pass", "sandbox", "Synthetic sandbox retest only; all observations documented in fixture evidence.");
  assert.equal(await page.locator("#audit-financial-findings input:checked").count(), 0, "review dialog must not retain old finding selections");
  await saveReview();
  saved = (await request(financial.report.id)).data;
  assert.equal(saved.audit.financial.summary.passed, 1);
  assert.equal(saved.audit.financial.summary.blocked, 0);
  assert.equal(saved.audit.reviews.length, 2, "older blocked review must remain in history");
  assert.equal(saved.audit.financial.readiness.status, "incomplete");
  assert.equal(await page.locator("#audit-history li").count(), 2);
  for (const format of ["json", "csv", "html"]) {
    const response = await fetch(`${baseUrl}/api/reports/${financial.report.id}/exports/${format}`);
    assert.equal(response.status, 200);
    const content = await response.text();
    assert.ok(content.includes(step.id), `${format} must include scenario evidence`);
    assert.match(content, /fixture-build-1/);
    assert.match(content, /synthetic-test-plan/);
    if (format === "html") assert.doesNotMatch(content, /<script>window\.financialUnsafe/);
  }

  await openStep();
  await page.locator("#audit-review-cancel").click();
  assert.equal(await page.locator("#audit-financial-execution").evaluate((fieldset) => fieldset.disabled), true);
  await page.locator('[data-review-target="1.1.1"]').click();
  assert.equal(await page.locator("#audit-financial-execution").isVisible(), false);
  assert.equal(await page.locator("#audit-execution-version").evaluate((input) => input.required), false);
  await page.locator("#audit-review-status").selectOption("Does Not Support");
  await page.locator("#audit-review-reviewer").fill("Criterion fixture reviewer");
  await page.locator("#audit-review-scope").fill("Synthetic observed default state");
  await page.locator("#audit-review-notes").fill("Confirmed missing label remains.");
  await page.locator("#audit-review-evidence").fill("confirmed-1");
  await saveReview();
  saved = (await request(financial.report.id)).data;
  assert.equal(saved.audit.reviews.length, 3);
  assert.equal(saved.audit.reviews[2].execution, undefined, "nonfinancial review must not send stale execution fields");
  assert.equal(saved.audit.criteria.find((entry) => entry.id === "1.1.1").status, "Does Not Support");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#financial-review-workspace").scrollIntoViewIfNeeded();
  assert.equal(await page.locator("#financial-review-workspace").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "financial workbook should not overflow horizontally on mobile");
  assert.equal(await page.locator(".skip-link").evaluate((node) => document.activeElement !== node && node.getBoundingClientRect().bottom < 0), true, "mobile skip link must remain offscreen when not focused");
  if (process.env.AUDIT_PREVIEW_DIR) await page.locator("#financial-review-workspace").screenshot({ path: path.join(process.env.AUDIT_PREVIEW_DIR, "financial-workbook-mobile.png") });

  await page.route("**/api/reports", (route) => route.fulfill({ json: [general.report, financial.report] }));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#tab-vpat").click();
  assert.equal(await page.locator("#financial-review-workspace").isVisible(), false, "general application must not show financial scenarios");
  assert.match(await page.locator("#audit-description").textContent(), /General web application/);
  assert.deepEqual(errors, []);
  for (const fixture of [financial, general]) assert.equal(await fs.readFile(path.join(fixture.directory, "vpat_draft.json"), "utf8"), fixture.original, "original scan evidence must be untouched");
  console.log("Financial workbook: 32 steps, context/evidence reviews, safety validation, preserved history, exports, general isolation, safe rendering and responsive UI passed.");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const directory of fixtureDirectories) {
    assert.equal(path.dirname(path.resolve(directory)), reportsRoot);
    assert.ok(path.basename(directory).startsWith("financial-workflow-fixture-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
