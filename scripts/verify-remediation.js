import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { app } from "../src/server.js";
import { getConfig } from "../src/config.js";

// Fixture reports for a synthetic host; everything is removed afterwards.
const host = "remediation-fixture.test";
const reportsDir = getConfig().reportsDir;
const base = `https://${host}`;
const issue = (id, ruleId, pageUrl, target, region = "main") => ({ id, ruleId, help: `${ruleId} help`, wcag: ["1.4.3"], impact: "serious", pageUrl, frameUrl: pageUrl, target: [target], region, state: "default", source: "axe-core" });
const report = (id, startedAt, issues) => ({
  id, targetUrl: base, startedAt, completedAt: startedAt, status: "complete",
  configuration: { audit: { profile: "general", wcagVersion: "2.2", level: "AA" } },
  pages: [{ url: `${base}/`, issueIds: [] }, { url: `${base}/a`, issueIds: [] }], issues, incomplete: [], bestPractices: [], graph: { nodes: [], edges: [] }, events: [], summary: { pagesScanned: 2 }
});
const ids = ["remediation-fixture-a", "remediation-fixture-b", "remediation-fixture-c"];
const header = issue("h1", "color-contrast", `${base}/`, "header > a", "global");
const image = issue("i1", "image-alt", `${base}/a`, "main > img");
const fresh = issue("n1", "link-name", `${base}/a`, "main > a");
const fixtures = [report(ids[0], "2026-10-01T00:00:00Z", [header, image]), report(ids[1], "2026-10-02T00:00:00Z", [header, fresh]), report(ids[2], "2026-10-03T00:00:00Z", [header, image, fresh])];
for (const entry of fixtures) {
  await fs.mkdir(path.join(reportsDir, entry.id), { recursive: true });
  await fs.writeFile(path.join(reportsDir, entry.id, "vpat_draft.json"), JSON.stringify(entry));
}
const server = await new Promise((resolve, reject) => { const result = app.listen(0, "127.0.0.1", () => resolve(result)); result.once("error", reject); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const api = async (method, suffix, body) => {
  const response = await fetch(`${baseUrl}/api/backlog/${host}${suffix}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text() };
};
let browser;
try {
  assert.equal((await api("POST", "/sync", { reportId: ids[0] })).data.added, 2);
  assert.equal((await api("POST", "/sync", { reportId: ids[0] })).data.alreadySynced, true, "a report is applied once");
  let backlog = (await api("GET", "")).data;
  const keyFor = (ruleId) => backlog.items.find((item) => item.ruleId === ruleId).key;
  assert.equal((await api("PATCH", `/items/${keyFor("image-alt")}`, { status: "fixed", owner: "Web team", note: "Alt text added" })).status, 200);
  assert.equal((await api("PATCH", `/items/${keyFor("color-contrast")}`, { status: "verified" })).status, 400, "an item the latest scan still finds cannot be marked verified");
  assert.equal((await api("PATCH", `/items/${keyFor("color-contrast")}`, { status: "made-up" })).status, 400);

  const second = (await api("POST", "/sync", { reportId: ids[1] })).data;
  assert.deepEqual([second.added, second.reopened, second.notFound], [1, 0, 1]);
  backlog = (await api("GET", "")).data;
  const imageItem = backlog.items.find((item) => item.ruleId === "image-alt");
  assert.equal(imageItem.latestScan, "not-found");
  assert.equal(imageItem.status, "fixed", "a defect missing from a scan is flagged, never closed automatically");
  assert.equal(backlog.summary.notFoundAwaitingVerification, 1);

  const third = (await api("POST", "/sync", { reportId: ids[2] })).data;
  assert.equal(third.reopened, 1, "a fixed item found again is reopened");
  backlog = (await api("GET", "")).data;
  assert.equal(backlog.items.find((item) => item.ruleId === "image-alt").status, "reopened");
  assert.match((await api("GET", "/export.csv")).data, /^Status,Issue,Rule/);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#report-current").selectOption(ids[2]);
  await page.waitForFunction(() => document.querySelector("#report-domain")?.textContent === "remediation-fixture.test");
  await page.locator("#tab-overview").focus();
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement.id), "tab-remediation", "End moves focus to the last tab");
  assert.equal(await page.locator("#panel-remediation").isVisible(), true);
  assert.equal(await page.locator("#tab-overview").getAttribute("tabindex"), "-1", "only the selected tab is in the Tab order");
  await page.waitForFunction(() => document.querySelectorAll("#remediation-body tr").length === 3);
  const select = page.getByLabel("Status for color-contrast help");
  await select.selectOption("in-progress");
  await page.getByRole("button", { name: "Save changes for color-contrast help" }).click();
  await page.waitForFunction(() => /Saved/.test(document.querySelector("#remediation-message").textContent));
  assert.equal((await api("GET", "")).data.items.find((item) => item.ruleId === "color-contrast").status, "in-progress");
  console.log("Remediation backlog passed: sync once, reopen, flag-not-close, verified guard, CSV export, dashboard edit and keyboard tabs.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  for (const id of ids) await fs.rm(path.join(reportsDir, id), { recursive: true, force: true });
  await fs.rm(path.join(reportsDir, "_backlog", `${host}.json`), { force: true });
}
