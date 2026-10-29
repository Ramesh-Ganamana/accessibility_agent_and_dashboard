import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runJourney } from "../src/journeys/runner.js";
import { validateJourney } from "../src/journeys/journey.js";

// Local synthetic application and journeys; nothing leaves the machine.
let addressSaves = 0;
const page = (title, body) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/login") return response.end(page("Login", `<h1>Sign in</h1><label for="e">Email</label><input id="e" type="email"><label for="p">Password</label><input id="p" type="password"><button type="button" onclick="location.href='/dashboard'">Sign in</button>`));
  if (request.url === "/dashboard") return response.end(page("Dashboard", `<h1>Dashboard</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><a href="/statements">Statements</a> <a href="/leave">Partner offer</a>`));
  if (request.url === "/statements") return response.end(page("Statements", `<h1>Statements</h1><form onsubmit="event.preventDefault(); fetch('/save', { method: 'POST' }).then(() => document.querySelector('#done').hidden = false)"><label for="a">Address</label><input id="a"><button>Save address</button></form><p id="done" hidden>Address saved</p>`));
  if (request.url === "/save") { addressSaves += 1; return response.end("ok"); }
  if (request.url === "/leave") { response.writeHead(302, { location: "http://partner.invalid/offer" }); return response.end(); }
  response.end(page("Home", "<h1>Home</h1>"));
});
const root = await fs.mkdtemp(path.join(os.tmpdir(), "journeys-"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await fs.writeFile(path.join(root, "data.json"), JSON.stringify({ email: "tester@sandbox.test", password: "Sandbox-Secret-981" }));
const write = async (name, steps, extra = {}) => {
  const file = path.join(root, `${name}.json`);
  await fs.writeFile(file, JSON.stringify({ name, environment: "sandbox", startUrl: `${origin}/login`, allowedOrigins: [origin], testData: "data.json", useSavedSession: false, ...extra, steps }));
  return file;
};
const config = getConfig({ login: false, headless: true, browserChannel: "bundled", aiEnabled: false });
config.reportsDir = path.join(root, "reports");
config.authStatePath = path.join(root, "auth.json");
config.legacyAuthStatePath = null;
const signIn = [
  { action: "checkpoint", name: "Login" },
  { action: "fill", target: { label: "Email" }, value: "{{email}}" },
  { action: "fill", target: { label: "Password" }, value: "{{password}}" },
  { action: "click", target: { role: "button", name: "Sign in" } },
  { action: "waitFor", text: "Dashboard" },
  { action: "checkpoint", name: "Dashboard", keyboard: false }
];
try {
  const full = await runJourney({ file: await write("full", [...signIn, { action: "click", target: { role: "link", name: "Statements" } }, { action: "assert", text: "Statements" }, { action: "checkpoint", name: "Statements" }]), config });
  assert.equal(full.journey.outcome, "completed", JSON.stringify(full.journey.steps.filter((step) => step.status !== "done")));
  assert.equal(full.pages.length, 3, "three checkpoints are scanned");
  assert.ok(full.issues.some((issue) => issue.ruleId === "image-alt" && issue.state === "journey:Dashboard"), "findings are attributed to their checkpoint");
  const saved = await fs.readFile(path.join(config.reportsDir, full.id, "vpat_draft.json"), "utf8");
  assert.equal(saved.includes("Sandbox-Secret-981") || saved.includes("tester@sandbox.test"), false, "test-data values never reach the report");
  assert.ok(full.journey.steps.some((step) => step.value === "{{password}}"), "fill steps record the test-data key, not the value");

  const unmarked = await runJourney({ file: await write("unmarked", [...signIn, { action: "goto", url: "/statements" }, { action: "fill", target: { label: "Address" }, value: "1 Test Street" }, { action: "click", target: { role: "button", name: "Save address" } }]), config });
  assert.equal(unmarked.journey.outcome, "blocked", "an unmarked Save click is refused");
  assert.equal(addressSaves, 0);

  const marked = await runJourney({ file: await write("marked", [...signIn, { action: "goto", url: "/statements" }, { action: "fill", target: { label: "Address" }, value: "1 Test Street" }, { action: "click", target: { role: "button", name: "Save address" }, consequential: true }, { action: "waitFor", text: "Address saved" }], { authorization: { reference: "TEST-PLAN-7" } }), config });
  assert.equal(marked.journey.outcome, "completed", "a marked consequential step runs in a sandbox with authorization");
  assert.equal(addressSaves, 1);

  const escape = await runJourney({ file: await write("escape", [...signIn, { action: "click", target: { role: "link", name: "Partner offer" } }, { action: "checkpoint", name: "Partner" }]), config });
  assert.equal(escape.journey.outcome, "blocked", "leaving allowedOrigins stops the journey");
  assert.equal(escape.pages.some((entry) => entry.title === "Partner"), false);

  assert.ok(validateJourney({ name: "x", environment: "production-read-only", startUrl: `${origin}/login`, allowedOrigins: [origin], steps: [{ action: "click", target: { text: "Pay" }, consequential: true }] }).some((error) => /production-read-only/.test(error)));
  assert.ok(validateJourney({ name: "x", environment: "sandbox", startUrl: "https://elsewhere.test/", allowedOrigins: [origin], steps: [{ action: "checkpoint", name: "a" }] }).some((error) => /inside allowedOrigins/.test(error)));
  assert.ok(validateJourney({ name: "x", environment: "live", startUrl: `${origin}/`, allowedOrigins: [origin], steps: [] }).length >= 2);
  console.log(`Journeys passed: ${full.pages.length} checkpoints, masked test data, consequential guard, authorized sandbox step, origin guard and validation.`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
