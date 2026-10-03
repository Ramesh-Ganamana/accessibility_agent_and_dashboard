import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";

const port = 4182;
const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><head><title>AI grounding crawl</title></head><body><main>
    <h1>Grounded application</h1>
    <div id="listener-only">Explore reports workspace</div>
    <section id="reports" hidden><h2>Reports workspace</h2></section>
    <script>document.querySelector('#listener-only').addEventListener('click',()=>document.querySelector('#reports').hidden=false)</script>
  </main></body></html>`);
});

const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-ai-grounding-crawl-"));
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
try {
  const config = getConfig({
    targetUrl: `http://127.0.0.1:${port}/`,
    maxPages: 3,
    maxDepth: 2,
    headless: true,
    browserChannel: "bundled",
    aiEnabled: true,
    aiCrawlerStallMs: 50,
    login: false,
    aiGroundingChooser: async ({ allowed }) => {
      const target = allowed.find((entry) => entry.label === "Explore reports workspace");
      assert.ok(target);
      assert.equal(target.detectedInteractive, false);
      return { action: "click", number: target.number, confidence: 0.99, reason: "fixture" };
    }
  });
  config.reportsDir = reportsDir;
  config.openAiApiKey = "fixture-key";
  const report = await runAccessibilityScan(config);
  assert.ok(report.graph.edges.some((edge) => edge.type === "ai-click" && edge.label.includes("Explore reports workspace")));
  assert.ok(report.graph.nodes.some((node) => node.state === "ai-interaction"));
  assert.ok(report.events.some((event) => event.type === "ai-grounding-wait"));
  console.log("Fifty-second-style stall hook and numbered DOM AI crawl fallback passed with a shortened fixture timeout.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(reportsDir, { recursive: true, force: true });
}
