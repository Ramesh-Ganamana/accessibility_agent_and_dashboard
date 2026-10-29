import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { app } from "../src/server.js";
import { getConfig } from "../src/config.js";

// A synthetic report in the real reports folder; removed afterwards.
const reportsDir = getConfig().reportsDir;
const id = `vpat-fixture-${Date.now().toString(36)}`;
const report = {
  id, targetUrl: "https://vpat-fixture.test", startedAt: "2026-10-10T00:00:00Z", completedAt: "2026-10-10T00:01:00Z", status: "complete",
  configuration: { audit: { profile: "general", wcagVersion: "2.2", level: "AA" } },
  summary: { pagesScanned: 1, statesObserved: 1, confirmedIssues: 1, needsReview: 0 },
  pages: [{ url: "https://vpat-fixture.test", issueIds: ["i1"] }], graph: { nodes: [], edges: [] }, incomplete: [], bestPractices: [], events: [],
  issues: [{ id: "i1", ruleId: "image-alt", wcag: ["1.1.1"], impact: "serious", help: "Images must have alternative text", pageUrl: "https://vpat-fixture.test", target: ["#logo"], state: "default", source: "axe-core" }]
};
await fs.mkdir(path.join(reportsDir, id), { recursive: true });
await fs.writeFile(path.join(reportsDir, id, "vpat_draft.json"), JSON.stringify(report));
const server = await new Promise((resolve, reject) => { const result = app.listen(0, "127.0.0.1", () => resolve(result)); result.once("error", reject); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const post = (suffix, body) => fetch(`${baseUrl}/api/reports/${id}${suffix}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let browser;
try {
  assert.equal((await post("/vpat-profile", { productName: "Fixture Portal", productVersion: "4.2", reportDate: "2026-10-15", contact: "a11y@fixture.test", description: "Customer portal" })).status, 200);
  assert.equal((await post("/vpat-profile", { reportDate: "15/10/2026" })).status, 400, "the report date is validated");
  const decision = { kind: "vpat-row", targetId: "508-302.1", status: "Partially Supports", reviewer: "Fixture reviewer", scope: "Chrome + NVDA 2026.2, portal pages", notes: "Images lack text alternatives on the home page.", evidence: ["fixture-case-7"] };
  assert.equal((await post("/reviews", decision)).status, 201);
  assert.equal((await post("/reviews", { ...decision, targetId: "508-999" })).status, 400, "unknown VPAT rows are rejected");
  assert.equal((await post("/reviews", { ...decision, status: "pass" })).status, 400, "VPAT rows use the official conformance terms");

  for (const edition of ["wcag", "508", "eu", "int"]) {
    const html = await (await fetch(`${baseUrl}/api/reports/${id}/vpat/${edition}/html`)).text();
    assert.match(html, /Fixture Portal Accessibility Conformance Report/);
    assert.match(html, /Based on VPAT® Version 2\.5/);
    assert.match(html, /DRAFT –/, "unreviewed rows keep the export marked as a draft");
    assert.match(html, /Table 1: Success Criteria, Level A/);
    assert.equal(/Revised Section 508 Report/.test(html), edition === "508" || edition === "int", `${edition} includes Section 508 only where expected`);
    assert.equal(/EN 301 549 Report/.test(html), edition === "eu" || edition === "int");
    if (edition === "508") assert.match(html, /302\.1 Without Vision<\/td><td>Partially Supports/, "a recorded 508 decision appears in the export");
    if (edition === "eu") {
      assert.match(html, /9\.1\.1\.1 Non-text Content/, "EN chapter 9 maps WCAG criteria");
      assert.equal(/9\.2\.5\.8/.test(html), false, "WCAG 2.2-only criteria are not listed in EN 301 549 V3.2.1 chapter 9");
    }
    const docx = Buffer.from(await (await fetch(`${baseUrl}/api/reports/${id}/vpat/${edition}/docx`)).arrayBuffer());
    assert.equal(docx.subarray(0, 2).toString(), "PK", `${edition} Word export is a valid package`);
    assert.ok(docx.length > 5_000);
  }
  assert.equal((await fetch(`${baseUrl}/api/reports/${id}/vpat/fake/html`)).status, 404);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#report-current").selectOption(id);
  await page.waitForFunction(() => document.querySelector("#report-domain")?.textContent === "vpat-fixture.test");
  await page.locator("#tab-vpat").click();
  await page.waitForFunction(() => document.querySelector("#vpat-product")?.value === "Fixture Portal");
  assert.match(await page.locator("#vpat-download-docx").getAttribute("href"), new RegExp(`/vpat/wcag/docx$`));
  await page.locator("#vpat-edition").selectOption("int");
  assert.match(await page.locator("#vpat-download-html").getAttribute("href"), /\/vpat\/int\/html$/);
  await page.locator("#vpat-export details summary").click();
  await page.getByRole("button", { name: "Record decision: 302.2 With Limited Vision" }).click();
  const options = await page.locator("#audit-review-status option").allTextContents();
  assert.ok(options.includes("Partially Supports") && !options.includes("Pass"), `VPAT rows offer conformance terms (${options.join(", ")})`);
  assert.deepEqual(errors, []);
  console.log("VPAT 2.5 exports passed: four editions in HTML and Word, 508/EN row decisions, draft gate, EN chapter 9 mapping and dashboard controls.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(path.join(reportsDir, id), { recursive: true, force: true });
}
