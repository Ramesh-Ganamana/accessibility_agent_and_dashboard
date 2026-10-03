import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";

const port = 4185;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/forbidden") {
    response.statusCode = 403;
    response.end("<!doctype html><html><body>Forbidden</body></html>");
    return;
  }
  response.end(`<!doctype html><html lang="en"><head><title>Needs review evidence</title></head><body><main>
    <h1>Review fixture</h1>
    <div style="background-image:linear-gradient(90deg,#fff,#000);padding:20px"><p id="uncertain" style="color:#777">Contrast requires contextual review</p></div>
  </main></body></html>`);
});

const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-needs-review-"));
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
try {
  const config = getConfig({ targetUrl: `http://127.0.0.1:${port}/`, maxPages: 1, maxDepth: 0, headless: true, browserChannel: "bundled", aiEnabled: false, login: false });
  config.reportsDir = reportsDir;
  config.authStatePath = path.join(reportsDir, "auth-state.json");
  const report = await runAccessibilityScan(config);
  const finding = report.incomplete.find((item) => item.ruleId === "color-contrast") || report.incomplete[0];
  assert.ok(finding, "fixture should produce at least one needs-review finding");
  assert.equal(finding.reviewStatus, "needs-review");
  assert.ok(finding.reviewHistory?.length, "needs-review finding should include review history");
  assert.ok(finding.evidence || finding.contextEvidence, "needs-review finding should include highlighted or contextual evidence");

  const blockedConfig = getConfig({ targetUrl: `http://127.0.0.1:${port}/forbidden`, maxPages: 1, maxDepth: 0, headless: true, browserChannel: "bundled", aiEnabled: false, login: false });
  blockedConfig.reportsDir = reportsDir;
  blockedConfig.authStatePath = path.join(reportsDir, "blocked-auth-state.json");
  const blockedReport = await runAccessibilityScan(blockedConfig);
  assert.equal(blockedReport.issues.length, 0, "an access-error document must not create confirmed accessibility findings");
  assert.equal(blockedReport.incomplete.length, 0, "an access-error document must not create needs-review findings");
  assert.match(blockedReport.pages[0]?.error || "", /Forbidden.*not evaluated/i, "the report should explain that the protected route was not evaluated");
  console.log("Needs-review evidence, review history, and access-error rejection passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(reportsDir, { recursive: true, force: true });
}
