import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { get as httpGet } from "node:http";
import { createDashboardApp } from "../src/api/app.js";
import { getConfig } from "../src/config.js";

async function fixture(t, options = {}) {
  const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "rambo-api-assembly-"));
  const config = { ...getConfig(), reportsDir, openAiApiKey: "", excludeActionLabels: [] };
  const app = createDashboardApp({ config, allowedHosts: "", nvdaCapability: () => ({ available: false, configured: false, reason: "Test fixture" }), ...options });
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    assert.ok(path.resolve(reportsDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(reportsDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, reportsDir, request: (route, options) => fetch(url + route, options) };
}

const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function terminal(request, id) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const job = await (await request(`/api/jobs/${id}`)).json();
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("The stub runner did not settle its job");
}

test("assembly retains health, local-only guards, JSON errors, and static ES modules", async (t) => {
  const { request, url } = await fixture(t);
  const health = await (await request("/api/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.nvda.reason, "Test fixture");
  // Node fetch rewrites Host; use the native HTTP client to exercise rebinding.
  const untrustedStatus = await new Promise((resolve, reject) => {
    httpGet(`${url}/api/health`, { headers: { Host: "untrusted.example" } }, (response) => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
  assert.equal(untrustedStatus, 421);
  assert.equal((await request("/api/scans", { ...post({}), headers: { ...post({}).headers, Origin: "https://untrusted.example" } })).status, 403);
  const invalid = await request("/api/scans", { ...post({}), body: "{" });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "The request contains invalid JSON." });
  for (const file of ["/", "/app.js", "/state.js", "/shared/ui.js", "/features/assistive-technology.js"]) {
    const response = await request(file);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get("content-type"), file === "/" ? /html/ : /javascript/, file);
    await response.text();
  }
});

test("specific report routes precede generic sections; interrupted status never rewrites evidence", async (t) => {
  const jobs = new Map();
  const { request, reportsDir } = await fixture(t, { jobs });
  const report = { id: "assembly-report", targetUrl: "https://example.test/", status: "in-progress", startedAt: "2026-01-01T00:00:00Z", pages: [], issues: [], incomplete: [], summary: {}, graph: { nodes: [], edges: [] } };
  await fs.mkdir(path.join(reportsDir, report.id));
  const file = path.join(reportsDir, report.id, "vpat_draft.json");
  const original = JSON.stringify(report);
  await fs.writeFile(file, original);
  assert.equal((await (await request(`/api/reports/${report.id}`)).json()).status, "interrupted");
  jobs.set("active", { status: "running", reportId: report.id });
  assert.equal((await (await request("/api/reports")).json())[0].status, "in-progress");
  for (const suffix of ["compliance", "vpat-profile", "score", "assistive-technology", "exports/json"]) {
    const response = await request(`/api/reports/${report.id}/${suffix}`);
    assert.equal(response.status, 200, suffix);
    await response.text();
  }
  assert.equal((await request(`/api/reports/${report.id}/unknown-section`)).status, 404);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("scan jobs preserve login, exclusions, NVDA intent, partial status and instance isolation", async (t) => {
  const previous = process.env.EXCLUDE_ACTION_LABELS;
  process.env.EXCLUDE_ACTION_LABELS = "Never delete";
  t.after(() => { if (previous === undefined) delete process.env.EXCLUDE_ACTION_LABELS; else process.env.EXCLUDE_ACTION_LABELS = previous; });
  let received;
  const first = await fixture(t, { scanRunner: async (config, onEvent) => {
    received = config;
    onEvent({ type: "nvda", message: "Synthetic test only" });
    return { id: "partial-fixture", status: "stopped", pages: [], stopReason: { code: "TEST_BROWSER_CLOSED", message: "Test browser closed" } };
  } });
  const second = await fixture(t);
  const response = await first.request("/api/scans", post({ targetUrl: "https://example.test/", maxPages: 1, maxStates: 2, excludeActionLabels: ["Medica", "Deactivate my account"], screenReaders: { nvda: true }, auth: { enabled: true, loginUrl: "https://example.test/login", username: "fixture-user", password: "fixture-secret" } }));
  assert.equal(response.status, 202);
  const initial = await response.json();
  assert.equal(initial.status, "queued");
  const job = await terminal(first.request, initial.id);
  assert.equal(job.status, "stopped");
  assert.equal(job.error, null);
  assert.equal(received.maxStates, 2);
  assert.equal(received.login.password, "fixture-secret");
  assert.equal(received.nvda.requested, true);
  assert.deepEqual(received.excludeActionLabels, ["Never delete", "Medica", "Deactivate my account"]);
  assert.doesNotMatch(JSON.stringify(job), /fixture-secret|fixture-user/);
  assert.equal((await second.request(`/api/jobs/${initial.id}`)).status, 404);
  assert.deepEqual(await fs.readdir(first.reportsDir), [], "partial scans must not sync the remediation backlog");
});

test("invalid scan and journey requests never start a runner", async (t) => {
  let invoked = false;
  const runner = async () => { invoked = true; throw Error("Must not run"); };
  const { request } = await fixture(t, { scanRunner: runner, journeyRunner: runner });
  for (const payload of [[], {}, { targetUrl: "file:///private" }, { targetUrl: "https://example.test", auth: { enabled: true, loginUrl: "https://example.test" } }, { targetUrl: "https://example.test", device: "mobile", screenReaders: { nvda: true } }]) {
    assert.equal((await request("/api/scans", post(payload))).status, 400);
  }
  assert.equal((await request("/api/journeys/run", post({ file: "../outside.json" }))).status, 400);
  assert.equal(invoked, false);
});

test("runner failures settle the job without stopping the dashboard", async (t) => {
  const { request } = await fixture(t, { scanRunner: async () => { throw Object.assign(Error("Fixture browser closed"), { code: "TEST_BROWSER_CLOSED" }); } });
  const response = await request("/api/scans", post({ targetUrl: "https://example.test" }));
  const job = await terminal(request, (await response.json()).id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /browser was closed/);
  assert.equal((await request("/api/health")).status, 200);
});
