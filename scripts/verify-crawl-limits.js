import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";

const requests = [];
const server = http.createServer((request, response) => {
  requests.push(request.url);
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><head><title>Crawl limit fixture</title></head><body><main>
    ${request.url === "/other"
      ? '<h1>Other page</h1><p>A distinct page was inspected.</p>'
      : `<h1>Application home</h1><a href="/other">Other page</a>
        <a href="/second">Second route</a><a href="/third">Third route</a>
        <button type="button" onclick="document.querySelector('#details').hidden=false">Open details</button>
        <button type="button" role="tab" aria-selected="false" onclick="this.setAttribute('aria-selected','true');document.querySelector('#activity').hidden=false">Activity</button>
        <section id="details" role="dialog" hidden><h2>Details dialog</h2><p>Details shown on the current page.</p></section>
        <section id="activity" hidden><h2>Recent activity</h2><p>Activity shown without navigating.</p></section>`}
    </main></body></html>`);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const targetUrl = `http://127.0.0.1:${server.address().port}`;
const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-crawl-limits-"));

async function scan(overrides) {
  const config = getConfig({ targetUrl, maxDepth: 1, maxPages: 1, maxStates: 8, browserChannel: "bundled", headless: true, aiEnabled: false, login: false, ...overrides });
  config.reportsDir = reportsDir;
  config.authStatePath = path.join(reportsDir, "auth-state.json");
  return runAccessibilityScan(config);
}

try {
  let nvdaCalls = 0;
  const singlePage = await scan({
    nvda: { requested: true },
    nvdaRunner: async ({ report }) => {
      nvdaCalls += 1;
      assert.equal(report.pages.length, 1);
      assert.ok(report.pages[0].observedStates.length >= 2, "NVDA runs after same-page interactions finish");
      throw new Error("Fixture NVDA runner unavailable");
    }
  });
  assert.equal(singlePage.pages.length, 1, "one page must remain one distinct page");
  assert.ok(singlePage.pages[0].observedStates.length >= 2, "one-page mode must still inspect dialog and tab states");
  assert.ok(singlePage.graph.edges.some((edge) => edge.label === "click: Open details"));
  assert.ok(singlePage.graph.edges.some((edge) => edge.label === "click: Activity"));
  assert.equal(requests.some((url) => url === "/other"), false, "known route links must not be followed after the page limit");
  assert.equal(singlePage.crawlTermination.reason, "page_limit_reached");
  assert.equal(singlePage.crawlTermination.remainingRoutes, 3);
  assert.equal(singlePage.configuration.maxStates, 8);
  assert.equal(nvdaCalls, 1, "optional NVDA runner should run once even when page capacity is reached");
  assert.equal(singlePage.assistiveTechnology.actualRuns.NVDA.status, "blocked", "NVDA failure must not fail the completed crawl");

  const twoPages = await scan({ maxPages: 2, maxStates: 4 });
  assert.equal(twoPages.pages.length, 2, "interaction states must leave capacity for a linked page");
  assert.ok(twoPages.pages.some((page) => page.url.endsWith("/other")));
  assert.ok(twoPages.summary.statesObserved <= 4, "global state safety cap must include page bases and interactions");
  assert.ok(twoPages.pages[0].observedStates.length > 0, "distinct page allowance must not disable interaction scans");
  assert.equal(requests.some((url) => ["/second", "/third"].includes(url)), false, "extra known routes should remain queued, not consume interaction clicks after route capacity is filled");

  const oneState = await scan({ maxPages: 3, maxStates: 1 });
  assert.equal(oneState.summary.statesObserved, 1);
  assert.equal(oneState.pages.length, 1);
  assert.equal(oneState.crawlTermination.reason, "state_limit_reached");
  assert.equal(oneState.crawlTermination.remainingRoutes, 3);
  assert.equal(oneState.crawlTermination.pageLimitReached, false);
  console.log("Independent page/state limits, one-page dialogs and tabs, linked-page capacity, and post-crawl NVDA invocation passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(reportsDir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(reportsDir).startsWith("clarity-crawl-limits-"));
  await fs.rm(reportsDir, { recursive: true, force: true });
}
