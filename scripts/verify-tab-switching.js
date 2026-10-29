import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { inspectApplicationTab } from "../src/browser/tabs.js";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";

// Local headless fixture only. The NVDA adapter below never starts a reader.
const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><head><title>Tab fixture</title></head><body><main>${request.url.startsWith("/child")
    ? '<h1>Child details</h1><script>document.write(opener ? "<button id=child-issue></button>" : "<p>Replay without opener</p>")</script>'
    : '<h1>Original application</h1><label>Draft <input id=draft value=unchanged></label><details open><summary>Information</summary>Expanded content</details><a id=open href="/child" target="_blank" rel="opener">Open details tab</a><div style="height:1800px"></div>'
  }</main></body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const targetUrl = `http://127.0.0.1:${server.address().port}`;
const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-tabs-"));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(targetUrl);
  await page.locator("#draft").fill("unsubmitted draft");
  for (const fail of [false, true]) {
    const pending = page.waitForEvent("popup");
    await page.locator("#open").click();
    const child = await pending;
    await child.waitForLoadState();
    await page.evaluate(() => { document.querySelector("#draft").focus(); scrollTo(0, 400); });
    const scroll = await page.evaluate(() => scrollY);
    const events = [];
    const task = inspectApplicationTab({ opener: page, popup: child, applicationUrl: targetUrl,
      emit: (event) => events.push(event), visit: async (tab) => {
        assert.equal(await tab.locator("#child-issue").count(), 1);
        if (fail) throw new Error("fixture visitor failure");
        return { status: "scanned" };
      } });
    if (fail) await assert.rejects(task, /fixture visitor failure/);
    else assert.equal((await task).parentStatePreserved, true);
    assert.ok(child.isClosed());
    assert.equal(await page.locator("#draft").inputValue(), "unsubmitted draft");
    assert.equal(await page.locator("details").getAttribute("open"), "");
    assert.equal(await page.evaluate(() => document.activeElement.id), "draft");
    assert.equal(await page.evaluate(() => scrollY), scroll);
    assert.ok(events.some((event) => event.type === "tab-return"));
  }
  await browser.close(); browser = null;

  for (const maxPages of [2, 1]) {
    const events = [], switches = [], tested = [];
    let root;
    const config = getConfig({ targetUrl, maxPages, maxStates: 4, maxDepth: 1,
      headless: true, browserChannel: "bundled", login: false, aiEnabled: false,
      nvda: { requested: true, mode: "during-crawl" },
      nvdaSessionFactory: async () => ({
        async preparePage(page) { root = page; },
        async switchToPage(page) { switches.push(page === root ? "return" : "child"); return true; },
        async resume() { return true; },
        async testState(page) {
          tested.push(page === root ? "root" : "child");
          if (page !== root) assert.equal(await page.locator("#child-issue").count(), 1);
          return { stateChanged: false };
        },
        async finish() { return { product: "NVDA", status: "fixture-only", actualExecution: false, states: [] }; },
        async close() {}
      }) });
    config.reportsDir = reportsDir;
    config.authStatePath = path.join(reportsDir, "auth.json");
    const report = await runAccessibilityScan(config, (event) => events.push(event));
    assert.equal(report.pages.length, maxPages, JSON.stringify(report.limitations));
    assert.ok(report.summary.statesObserved <= 4);
    assert.equal(report.pages[0].error, null);
    if (maxPages === 2) {
      const child = report.pages.find((entry) => entry.url.endsWith("/child"));
      assert.ok(child?.openedFrom, "child must be inspected live, not navigated later");
      assert.equal(child.error, null);
      assert.ok(report.issues.some((issue) => issue.ruleId === "button-name"), "capture opener-dependent child issue");
      assert.ok(report.graph.edges.some((edge) => edge.type === "popup"));
      assert.ok(tested.includes("child"), "live NVDA hook must receive the child Page");
      assert.deepEqual(switches.slice(0, 2), ["child", "return"]);
      assert.ok(events.some((event) => event.type === "tab-return"));
    } else assert.ok(!tested.includes("child"), "page cap must prevent child testing");
  }
  console.log("Tab scan/return, live NVDA handoff hooks, opener-dependent evidence, input/focus/scroll preservation, failure cleanup and page/state caps passed (headless, mock NVDA).");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(reportsDir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(reportsDir).startsWith("clarity-tabs-"));
  await fs.rm(reportsDir, { recursive: true, force: true });
}
