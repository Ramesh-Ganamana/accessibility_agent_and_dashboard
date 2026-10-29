import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { app } from "../src/server.js";
import { getConfig } from "../src/config.js";
import { importComplianceSet, listComplianceSets, renderComplianceCsv, complianceForReport } from "../src/report/compliance.js";

// A synthetic report and an imported checklist in the real reports folder;
// both are removed afterwards.
const reportsDir = getConfig().reportsDir;
const stamp = Date.now().toString(36);
const id = `compliance-fixture-${stamp}`;
const setId = `verify-fixture-${stamp}`;
const customDir = path.join(reportsDir, "_compliance");
const hadCustomDir = await fs.stat(customDir).then(() => true, () => false);
const report = {
  id, targetUrl: "https://compliance-fixture.test", startedAt: "2026-10-10T00:00:00Z", completedAt: "2026-10-10T00:01:00Z", status: "complete",
  configuration: { audit: { profile: "financial", wcagVersion: "2.2", level: "AA" } },
  summary: { pagesScanned: 1, statesObserved: 1, confirmedIssues: 1, needsReview: 0 },
  pages: [{ url: "https://compliance-fixture.test", issueIds: ["i1"] }], graph: { nodes: [], edges: [] }, incomplete: [], bestPractices: [], events: [],
  issues: [{ id: "i1", ruleId: "image-alt", wcag: ["1.1.1"], impact: "serious", help: "Images must have alternative text", pageUrl: "https://compliance-fixture.test", target: ["#logo"], state: "default", source: "axe-core" }]
};
await fs.mkdir(path.join(reportsDir, id), { recursive: true });
await fs.writeFile(path.join(reportsDir, id, "vpat_draft.json"), JSON.stringify(report));
const server = await new Promise((resolve, reject) => { const result = app.listen(0, "127.0.0.1", () => resolve(result)); result.once("error", reject); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const post = (url, body) => fetch(`${baseUrl}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let browser;
try {
  const catalog = listComplianceSets(reportsDir);
  const gigw = catalog.sets.find((set) => set.id === "gigw-3.0");
  const sebi = catalog.sets.find((set) => set.id === "sebi-digital-accessibility");
  assert.ok(gigw?.items.length >= 50 && sebi?.items.length >= 20, "GIGW 3.0 and SEBI sets are built in");
  assert.match(catalog.notice, /IS 17802 is a paid BIS standard and is not included/);
  assert.equal(catalog.sets.some((set) => /17802/.test(set.id)), false, "no IS 17802 clauses are invented");
  for (const set of [gigw, sebi]) {
    assert.equal(new Set(set.items.map((item) => item.id)).size, set.items.length, `${set.id} item ids are unique`);
    for (const item of set.items) {
      assert.match(item.sourceUrl, /^https:\/\//, `${set.id} ${item.id} cites a source URL`);
      assert.ok(item.sourceTitle && item.requirement && item.reference, `${set.id} ${item.id} has a reference, requirement and source title`);
      assert.ok(item.wcag.every((criterion) => /^\d+\.\d+\.\d+$/.test(criterion)), `${set.id} ${item.id} WCAG references are well formed`);
    }
  }

  const csv = 'reference,title,requirement,wcag,source\r\n"4.1","Text alternatives","Provide text alternatives, including for ""decorative"" images\nthat convey meaning","1.1.1; 1.4.5","Licensed copy"\r\n4.2,Contrast,=HYPERLINK("x"),1.4.3,Licensed copy\r\n';
  const imported = await post("/api/compliance/sets", { id: setId, title: "Fixture licensed checklist", format: "csv", csv });
  assert.equal(imported.status, 201, await imported.clone().text());
  assert.deepEqual(await imported.json(), { id: setId, title: "Fixture licensed checklist", items: 2 });
  assert.equal((await post("/api/compliance/sets", { id: "gigw-3.0", title: "x", format: "csv", csv })).status, 400, "built-in ids cannot be overwritten");
  assert.equal((await post("/api/compliance/sets", { id: "bad-csv", title: "x", format: "csv", csv: "clause,text\n1,a" })).status, 400, "CSV needs reference and requirement columns");
  assert.equal((await post("/api/compliance/sets", { id: "../escape", title: "x", items: [{ reference: "1", requirement: "a" }] })).status, 400, "ids cannot contain paths");
  await assert.rejects(importComplianceSet(reportsDir, { id: "empty-set", title: "x", items: [] }), /no items/);

  const sets = await (await fetch(`${baseUrl}/api/compliance/sets`)).json();
  const listed = sets.sets.find((set) => set.id === setId);
  assert.equal(listed.items, 2, "the set list reports item counts");
  assert.equal(listed.builtIn, false);

  const custom = listComplianceSets(reportsDir).sets.find((set) => set.id === setId);
  assert.match(custom.items[0].requirement, /including for "decorative" images that convey meaning/, "quoted CSV fields keep commas, quotes and line breaks");
  assert.deepEqual(custom.items[0].wcag, ["1.1.1", "1.4.5"]);
  const gigwImage = gigw.items.find((item) => item.wcag.includes("1.1.1"));
  assert.ok(gigwImage, "a GIGW item maps to WCAG 1.1.1");

  const decision = { kind: "compliance-item", targetId: `gigw-3.0::${gigwImage.id}`, status: "partially-met", reviewer: "Fixture reviewer", scope: "Chrome + NVDA, home page", notes: "Logo image lacks alternative text.", evidence: ["fixture-case-9"] };
  assert.equal((await post(`/api/reports/${id}/reviews`, decision)).status, 201);
  assert.equal((await post(`/api/reports/${id}/reviews`, { ...decision, targetId: `${setId}::${custom.items[1].id}`, status: "met" })).status, 201, "imported items take decisions");
  assert.equal((await post(`/api/reports/${id}/reviews`, { ...decision, status: "Supports" })).status, 400, "checklist items use met / partially met / not met / not applicable");
  assert.equal((await post(`/api/reports/${id}/reviews`, { ...decision, targetId: "gigw-3.0::no-such-item" })).status, 400, "unknown items are rejected");

  const compliance = await (await fetch(`${baseUrl}/api/reports/${id}/compliance`)).json();
  const reviewed = compliance.sets.find((set) => set.id === "gigw-3.0").items.find((item) => item.id === gigwImage.id);
  assert.equal(reviewed.status, "partially-met");
  assert.equal(reviewed.relatedWcag.find((entry) => entry.id === "1.1.1").findings, 1, "related WCAG results come from this scan");
  assert.equal(compliance.sets.find((set) => set.id === "gigw-3.0").summary.reviewed, 1);
  assert.equal(compliance.sets.find((set) => set.id === "sebi-digital-accessibility").summary.reviewed, 0, "decisions never carry across checklists");

  const exported = await fetch(`${baseUrl}/api/reports/${id}/compliance/export.csv`);
  const exportedText = await exported.text();
  assert.match(exported.headers.get("content-disposition"), /compliance-checklists-/);
  assert.match(exportedText, /Logo image lacks alternative text\./);
  assert.match(exportedText, /'=HYPERLINK/, "formula-like cells are neutralised in CSV exports");
  assert.equal(renderComplianceCsv(complianceForReport(reportsDir, { auditReviews: [] })).split("\r\n").length > 100, true);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#report-current").selectOption(id);
  await page.waitForFunction(() => document.querySelector("#report-domain")?.textContent === "compliance-fixture.test");
  await page.locator("#tab-vpat").click();
  await page.waitForFunction(() => document.querySelectorAll("#compliance-body tr").length > 10);
  assert.match(await page.locator("#compliance-summary").textContent(), /1 of \d+ requirements have a documented decision/);
  await page.locator("#compliance-set").selectOption(setId);
  await page.waitForFunction(() => document.querySelectorAll("#compliance-body tr").length === 2);
  await page.getByRole("button", { name: "Record decision: 4.1 Text alternatives" }).click();
  const options = await page.locator("#audit-review-status option").allTextContents();
  assert.ok(options.includes("Partially met") && options.includes("Not applicable") && !options.includes("Supports"), `checklist items offer checklist terms (${options.join(", ")})`);
  assert.deepEqual(errors, []);
  console.log(`Compliance checklists passed: GIGW 3.0 (${gigw.items.length}) and SEBI (${sebi.items.length}) built in with sources, CSV import, documented decisions, related WCAG evidence, CSV export and dashboard controls.`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(path.join(reportsDir, id), { recursive: true, force: true });
  await fs.rm(path.join(customDir, `${setId}.json`), { force: true });
  if (!hadCustomDir) await fs.rmdir(customDir).catch(() => {});
}
