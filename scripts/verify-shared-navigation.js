import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";

// A three-page local site with the same header menu on every page. The shared
// menu must be scanned once; each page's own disclosure must still be scanned.
const page = (name) => `<!doctype html><html lang="en"><head><title>${name}</title></head><body>
<header><nav aria-label="Main"><button type="button" aria-expanded="false" onclick="this.setAttribute('aria-expanded', String(this.getAttribute('aria-expanded') !== 'true')); document.querySelector('#menu').hidden = this.getAttribute('aria-expanded') !== 'true'">Services</button>
<ul id="menu" hidden><li><a href="/alpha">Alpha</a></li><li><a href="/beta">Beta</a></li></ul></nav></header>
<main><h1>${name} page</h1><p>Content that belongs only to the ${name} page.</p>
<button type="button" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); this.nextElementSibling.hidden = false">${name} details</button><div hidden><h2>${name} detail panel</h2></div></main>
<div class="outside-landmarks">Footer note outside any landmark.</div>
</body></html>`;

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(page(request.url === "/alpha" ? "Alpha" : request.url === "/beta" ? "Beta" : "Home"));
});
const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-navigation-"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const config = getConfig({ targetUrl: `http://127.0.0.1:${server.address().port}/`, maxPages: 3, maxDepth: 2, maxStates: 20, headless: true, browserChannel: "bundled", aiEnabled: false, login: false });
  config.reportsDir = reportsDir;
  config.authStatePath = path.join(reportsDir, "auth.json");
  config.legacyAuthStatePath = null;
  const report = await runAccessibilityScan(config);

  assert.equal(report.status, "complete");
  assert.equal(report.pages.length, 3);
  const [home, ...later] = report.pages;
  const stateOf = (entry, label) => entry.stateEdges.find((edge) => edge.label === `click: ${label}` && edge.source === entry.url)?.target || "";
  assert.ok(stateOf(home, "Services").startsWith(`${home.url}::state:`), "the shared menu is scanned on the first page");
  assert.ok(stateOf(home, "Home details").startsWith(`${home.url}::state:`), "the first page's own disclosure is scanned");
  for (const entry of later) {
    const name = entry.url.endsWith("/alpha") ? "Alpha" : "Beta";
    assert.equal(stateOf(entry, "Services"), stateOf(home, "Services"), `${name} links the shared menu to its earlier scan`);
    assert.ok(stateOf(entry, `${name} details`).startsWith(`${entry.url}::state:`), `${name}'s own disclosure must still be scanned`);
    assert.equal(entry.observedStates.length, 1, `${name} scans only its own state, not the shared menu again`);
  }
  assert.ok(report.summary.sharedStatesReused >= 2, `later pages must link the shared menu state (reused ${report.summary.sharedStatesReused})`);
  assert.ok(report.issues.every((issue) => issue.wcag?.length), "confirmed findings contain only WCAG-mapped rules");
  assert.ok(report.bestPractices.some((finding) => finding.ruleId === "region"), "best-practice rules are kept in their own group");
  const saved = JSON.parse(await fs.readFile(path.join(reportsDir, report.id, "summary.json"), "utf8"));
  assert.equal(saved.status, "complete");
  console.log(`Shared navigation passed: ${report.summary.statesObserved} states, ${report.summary.sharedStatesReused} shared states linked instead of re-scanned, ${report.issues.length} WCAG and ${report.bestPractices.length} best-practice findings.`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(reportsDir, { recursive: true, force: true });
}
