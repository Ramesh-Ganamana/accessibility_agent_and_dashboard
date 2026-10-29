import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";
import { runJourney } from "../src/journeys/runner.js";

// Full scans and journeys against a local application: every entry on the
// Do not click list stays unclicked after canonical redirects, on a landing
// host, for normalized link addresses, behind dialogs and clickable cards.
const requests = [];
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
let port;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  requests.push({ host: request.headers.host, path: url.pathname, search: url.search });
  const html = (title, body) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page(title, body)); };
  if (url.pathname.startsWith("/hit/")) { response.writeHead(204); return response.end(); }
  if (url.pathname.endsWith(".pdf")) { response.writeHead(200, { "content-type": "application/pdf" }); return response.end(pdf); }
  if (url.pathname === "/start-www") { response.writeHead(302, { location: `http://www.localhost:${port}/app` }); return response.end(); }
  if (url.pathname === "/start-foreign") { response.writeHead(302, { location: `http://localhost:${port}/home` }); return response.end(); }
  if (url.pathname === "/journey-start") { response.writeHead(302, { location: `http://www.localhost:${port}/journey` }); return response.end(); }
  if (url.pathname === "/app") return html("Canonical app", `<a href="/docs/annual.pdf">Annual statement</a> <a href="/team/roster">Staff list</a> <a href="/next">Next page</a>`);
  if (url.pathname === "/next") return html("Next page", `<p>Survey page</p>
    <div id="survey" role="dialog" aria-modal="true" aria-labelledby="survey-title" style="position:fixed;inset:20% 30%;background:#fff;border:1px solid #000;padding:20px;z-index:10">
      <h2 id="survey-title">Rate us?</h2><button type="button" onclick="fetch('/hit/not-now');document.getElementById('survey').remove()">Not now</button></div>`);
  if (url.pathname === "/home") return html("Landing host", `<button type="button" onclick="fetch('/hit/alpha');document.getElementById('panel').hidden=false">Alpha Panel</button>
    <button type="button" onclick="fetch('/hit/open');document.getElementById('panel').hidden=false">Open panel</button><section id="panel" hidden><h2>Panel</h2></section>`);
  if (url.pathname === "/urls") return html("Link addresses", `<a href="/team/roster/">Staff list</a> <a href="/billing/summary#top">Account overview</a>
    <a href="/report?id=7&utm_source=nav">Monthly numbers</a> <a href="/docs/handbook.pdf#page=2">Handbook</a> <a href="/plain">Plain page</a>
    <button type="button" onclick="location.href='/team/roster'">Open roster</button>`);
  if (url.pathname === "/widgets") return html("Widgets", `<button type="button" onclick="document.getElementById('notice').showModal()">Open notice</button>
    <dialog id="notice" aria-labelledby="notice-title"><h2 id="notice-title">Important notice</h2><button type="button" onclick="this.closest('dialog').close()">Close</button></dialog>
    <div id="team" style="cursor:pointer;display:inline-block;padding:8px"><h3>Team page</h3><span>Opens the staff directory</span></div>
    <div id="holiday" style="cursor:pointer;display:inline-block;padding:8px"><h3>Holiday calendar</h3><span>See upcoming dates</span></div>
    <section id="team-panel" hidden><h2>Staff</h2></section><section id="holiday-panel" hidden><h2>Holidays</h2></section>
    <script>
      document.getElementById('notice').addEventListener('cancel', () => fetch('/hit/escape'));
      document.getElementById('team').addEventListener('click', () => { fetch('/hit/card-team'); document.getElementById('team-panel').hidden = false; });
      document.getElementById('holiday').addEventListener('click', () => { fetch('/hit/card-holiday'); document.getElementById('holiday-panel').hidden = false; });
    </script>`);
  if (url.pathname === "/journey" || url.pathname === "/journey-focus") return html("Journey", `<button type="button" ${url.pathname === "/journey-focus" ? "autofocus" : ""} onclick="fetch('/hit/contact')">Contact sales</button>
    <label for="switcher">Account switcher</label><select id="switcher" onchange="fetch('/hit/select')"><option>Personal</option><option>Business</option></select>
    <button type="button" onclick="fetch('/hit/view')">View plans</button>`);
  return html("Plain page", `<p>${url.pathname}</p><a href="/">Home</a>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
port = server.address().port;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "exclusion-crawl-"));
const hits = (since) => requests.slice(since).filter((entry) => entry.path.startsWith("/hit/")).map((entry) => entry.path.slice(5));
const paths = (since) => requests.slice(since).map((entry) => entry.path);
const scan = async (targetUrl, excludeActionLabels, overrides = {}) => {
  const config = getConfig({ targetUrl, maxPages: 3, maxStates: 10, maxDepth: 2, headless: true, browserChannel: "bundled", aiEnabled: false, login: false,
    keyboardMaxTabs: 5, appShellWaitMs: 2_000, documentsMax: 3, excludeActionLabels, ...overrides });
  config.openAiApiKey = "";
  config.reportsDir = root;
  config.authStatePath = path.join(root, "auth-state.json");
  return runAccessibilityScan(config);
};

try {
  // A start address that redirects to its www variant: blocker recovery, the
  // document check and an absolute entry written for the typed origin.
  let mark = requests.length;
  let report = await scan(`http://localhost:${port}/start-www`, ["Annual statement", "Not now", `http://localhost:${port}/team/roster`]);
  assert.equal(report.configuration.excludedActionOrigin, `http://www.localhost:${port}`);
  assert.ok(report.pages.some((entry) => /\/next$/.test(entry.actualUrl || entry.url)), "the redirected application was crawled");
  assert.deepEqual(hits(mark), [], "the listed dismiss control stays unclicked after the www redirect");
  assert.ok(!paths(mark).includes("/docs/annual.pdf") && !paths(mark).includes("/team/roster"), `listed PDF and page stay unrequested: ${paths(mark).join(" ")}`);

  // A start address that lands on another host: the list applies there too.
  mark = requests.length;
  report = await scan(`http://127.0.0.1:${port}/start-foreign`, ["Alpha Panel"], { maxPages: 1 });
  assert.ok(report.configuration.excludedActionOrigins?.includes(`http://localhost:${port}`), "the landing host joins the exclusion scope");
  assert.ok(!hits(mark).includes("alpha"), "the listed control on the landing host stays unclicked");
  assert.ok(hits(mark).includes("open"), "unlisted controls on the landing host are still explored");

  // URL entries match normalized addresses; script navigation to them is refused.
  mark = requests.length;
  report = await scan(`http://127.0.0.1:${port}/urls`, ["/team/roster", `http://127.0.0.1:${port}/billing/summary`, "/report?id=7", "/docs/handbook.pdf"]);
  const loaded = paths(mark);
  for (const listed of ["/team/roster", "/team/roster/", "/billing/summary", "/report", "/docs/handbook.pdf"]) assert.ok(!loaded.includes(listed), `${listed} must not be requested (${loaded.join(" ")})`);
  assert.ok(loaded.includes("/plain"), "unlisted routes are still crawled");

  // Escape is not used on a dialog whose close control is listed, and a listed
  // clickable card is not activated through its inner text.
  mark = requests.length;
  report = await scan(`http://127.0.0.1:${port}/widgets`, ["Close", "Team page"], { maxPages: 1 });
  assert.ok(!hits(mark).includes("escape"), "Escape must not dismiss a dialog whose close control is listed");
  assert.ok(!hits(mark).includes("card-team"), "the listed card stays unclicked");
  assert.ok(hits(mark).includes("card-holiday"), "the unlisted card is still explored");

  // Journeys: scoped to the journey's own application (not TARGET_URL), www
  // redirect included; listed steps are refused and reported as blocked.
  const entries = ["Contact sales", "Account switcher", "/journey-goto-listed"];
  const journeyConfig = getConfig({ targetUrl: "http://127.0.0.1:9/", excludeActionOrigin: "http://127.0.0.1:9", excludeActionLabels: entries, login: false, headless: true, browserChannel: "bundled" });
  journeyConfig.reportsDir = root;
  journeyConfig.authStatePath = path.join(root, "journey-auth.json");
  const allowedOrigins = [`http://localhost:${port}`, `http://www.localhost:${port}`];
  const journey = async (name, startPath, steps) => {
    const file = path.join(root, `${name}.json`);
    await fs.writeFile(file, JSON.stringify({ name, environment: "sandbox", startUrl: `http://localhost:${port}${startPath}`, allowedOrigins, useSavedSession: false, steps }));
    const before = requests.length;
    const result = await runJourney({ file, config: journeyConfig });
    return { result, hits: hits(before), paths: paths(before) };
  };
  let run = await journey("click-listed", "/journey-start", [{ action: "click", target: { role: "button", name: "View plans" } }, { action: "click", target: { role: "button", name: "Contact sales" } }]);
  assert.deepEqual(run.result.journey.steps.map((step) => step.status), ["done", "blocked"]);
  assert.equal(run.result.journey.outcome, "blocked");
  assert.deepEqual(run.hits, ["view"]);
  assert.deepEqual(run.result.configuration.excludedActionLabels, entries, "the journey report lists the Do not click entries");
  run = await journey("select-listed", "/journey-start", [{ action: "select", target: { label: "Account switcher" }, value: "Business" }]);
  assert.deepEqual(run.result.journey.steps.map((step) => step.status), ["blocked"]);
  assert.deepEqual(run.hits, []);
  run = await journey("goto-listed", "/journey-start", [{ action: "goto", url: "/journey-goto-listed" }]);
  assert.deepEqual(run.result.journey.steps.map((step) => step.status), ["blocked"]);
  assert.ok(!run.paths.includes("/journey-goto-listed"));
  run = await journey("press-listed", "/journey-focus", [{ action: "press", key: "Enter" }]);
  assert.deepEqual(run.result.journey.steps.map((step) => step.status), ["blocked"]);
  assert.deepEqual(run.hits, []);
  // Arrow keys change a focused listed <select> without any click.
  run = await journey("arrow-listed", "/journey-start", [{ action: "click", target: { role: "button", name: "View plans" } }, { action: "press", key: "Shift+Tab" }, { action: "press", key: "ArrowDown" }]);
  assert.deepEqual(run.result.journey.steps.map((step) => step.status), ["done", "done", "blocked"]);
  assert.deepEqual(run.hits, ["view"], "ArrowDown must not change the listed select");
  console.log("Do not click list held after www and landing-host redirects, for normalized and script-opened URLs, PDFs, dialogs, clickable cards and every journey step type.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
