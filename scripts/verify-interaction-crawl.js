import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";

const port = 4178;
const externalPort = 4181;
const externalServer = http.createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(page("<h1>External identity destination</h1>"));
});
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/next") {
    response.end(page("<h1>Next route</h1><p>This route was reached through a JavaScript button.</p>"));
    return;
  }
  if (request.url === "/excluded") {
    response.end(page("<h1>This route must remain excluded</h1>"));
    return;
  }
  response.end(page(`
    <h1 id="app-heading">Interaction test</h1>
    <button type="button" onclick="document.querySelector('#menu').hidden=false">Open menu</button>
    <div role="button" tabindex="0" onclick="document.querySelector('#details').hidden=false">View details</div>
    <span role="button" tabindex="0" onclick="document.querySelector('#dialog').hidden=false">Open dialog</span>
    <button type="button" onclick="setTimeout(()=>document.querySelector('#domain-dialog').hidden=false,250)">Open reporting workspace</button>
    <button type="button" onclick="location.href='/next'">Go next</button>
    <div role="button" tabindex="0" onclick="location.href='http://127.0.0.1:${externalPort}/register'">External organization</div>
    <button type="button" onclick="location.href='/excluded'">Excluded provider</button>
    <button type="button" onclick="location.href='/register'">Create account</button>
    <button type="button" onclick="document.body.dataset.deleted='true'">Delete record</button>
    <shadow-navigation></shadow-navigation>
    <section id="menu" hidden><h2>Application menu</h2></section>
    <section id="details" hidden><h2>Employee details</h2></section>
    <section id="shadow-panel" hidden><h2>Shadow navigation panel</h2></section>
    <div id="dialog" role="dialog" aria-label="Profile dialog" hidden><h2>Profile dialog</h2></div>
    <div id="domain-dialog" role="dialog" aria-modal="true" hidden>
      <h2>Select a Domain</h2>
      <input placeholder="Search Domains">
      <div id="domain-jcb" role="option">JCB</div>
    </div>
    <section id="domain-result" hidden><h2>JCB workspace dashboard</h2></section>
    <script>
      const shadow = document.querySelector('shadow-navigation').attachShadow({ mode: 'open' });
      shadow.innerHTML = '<button type="button">Open shadow panel</button>';
      shadow.querySelector('button').onclick = () => document.querySelector('#shadow-panel').hidden = false;
      document.querySelector('#domain-jcb').onclick = () => {
        document.querySelector('#domain-dialog').hidden = true;
        document.querySelector('#domain-result').hidden = false;
        document.querySelector('#app-heading').textContent = 'JCB workspace dashboard';
      };
    </script>
  `));
});

const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-action-crawl-"));
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
await new Promise((resolve) => externalServer.listen(externalPort, "127.0.0.1", resolve));
try {
  const config = getConfig({
    targetUrl: `http://127.0.0.1:${port}/`,
    maxPages: 8,
    maxStates: 8,
    maxDepth: 2,
    headless: true,
    browserChannel: "bundled",
    aiEnabled: false,
    excludeActionLabels: ["Excluded provider"],
    login: { url: "", username: "", password: "", postLoginValue: "JCB" }
  });
  config.reportsDir = reportsDir;
  config.authStatePath = path.join(reportsDir, "auth-state.json");
  const report = await runAccessibilityScan(config);
  const labels = report.graph.edges.map((edge) => edge.label);

  assert.ok(labels.includes("click: Open menu"));
  assert.ok(labels.includes("click: View details"));
  assert.ok(labels.includes("click: Open dialog"));
  assert.ok(labels.includes("click: Open reporting workspace"));
  assert.ok(labels.includes("click: Open shadow panel"));
  assert.ok(labels.includes("click: Go next"));
  assert.ok(!labels.some((label) => label.includes("Delete record")));
  assert.ok(!labels.some((label) => label.includes("Create account")));
  assert.ok(!labels.some((label) => label.includes("Excluded provider")));
  assert.ok(!report.graph.nodes.some((node) => node.url.endsWith("/excluded")));
  assert.ok(!report.graph.nodes.some((node) => node.url.includes(`:${externalPort}`)));
  assert.ok(report.events.some((event) => event.message.includes("left the application for an external origin")));
  assert.ok(
    report.events.some((event) => event.type === "post-login-context-selected" && event.message.includes("JCB")),
    `Expected late context selection event. Events: ${report.events.map((event) => `${event.type}: ${event.message}`).join(" | ")}`
  );
  assert.ok(!report.graph.nodes.some((node) => node.label.includes("Select a Domain")));
  assert.ok(report.graph.nodes.some((node) => node.state === "dialog"));
  assert.ok(report.graph.nodes.some((node) => node.url.endsWith("/next")));
  assert.ok(report.pages.length <= config.maxPages);
  assert.ok(report.graph.nodes.length <= config.maxStates);
  assert.equal(report.assistiveTechnology.actualScreenReaders.NVDA, "not-run");
  assert.ok(report.pages.some((page) => page.screenReaderStates?.length), "observed states should include Chromium accessibility-tree snapshots");
  assert.ok(report.summary.accessibilityTreeStates > 0, "summary should count inspected accessibility-tree states");
  assert.ok(report.incomplete.some((finding) => finding.ruleId === "focus-visible"), "focus heuristics must remain human-review findings");
  assert.equal(report.issues.some((finding) => finding.findingType === "needs-review"), false, "uncertain heuristics must not inflate confirmed issues");
  assert.ok(report.graph.nodes.every((node) => typeof node.findingState === "string"), "graph nodes must expose their exact finding state for issue filtering");
  console.log("Bounded interaction crawl passed for buttons, divs, spans, dialogs, routes, depth, and unsafe-action exclusion.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => externalServer.close(resolve));
  await fs.rm(reportsDir, { recursive: true, force: true });
}

function page(body) {
  return `<!doctype html><html lang="en"><head><title>Interaction crawler test</title><style>*:focus{outline:none;box-shadow:none}</style></head><body><main>${body}</main></body></html>`;
}
