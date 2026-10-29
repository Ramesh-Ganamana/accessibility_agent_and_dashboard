import express from "express";
import { fileURLToPath } from "node:url";
import { compareReports } from "../../src/report/comparison.js";
import { reportSection } from "../../src/report/assessment.js";

// In-memory reports keep UI verification independent of a running server or private scan history.
function makeReport(id, domain, hour, current = true) {
  const url = `https://${domain}/`;
  const issue = (suffix, state = "default") => ({
    id: `${id}-${suffix}`, ruleId: "image-alt", impact: "serious", help: `${suffix} image needs alternative text`,
    target: [`#${suffix}`], wcag: ["1.1.1"], pageUrl: url, frameUrl: url, state, source: "axe-core",
    evidence: "evidence/fixture.png", failureSummary: "The fixture image has no text alternative."
  });
  const states = ["Account", "Help"].map((label) => ({
    id: `${url}::state:${label}`, stateId: label, label, url, depth: 1, issueCount: 1,
    status: "scanned", state: "dialog", findingState: `dialog:${label}`
  }));
  const issues = [issue("shared"), issue(current ? "new" : "fixed"), issue("account", "dialog:Account"), issue("help", "dialog:Help")];
  const incomplete = [{ ...issue("review"), ruleId: "color-contrast", wcag: ["1.4.3"], reviewStatus: "needs-review", reviewHistory: [{
    at: "2026-01-01T00:00:00.000Z", message: "The background could not be resolved.", source: "axe-core"
  }] }];
  return {
    id, targetUrl: url, startedAt: `2026-01-01T${hour}:00:00.000Z`, completedAt: `2026-01-01T${hour}:01:00.000Z`,
    summary: { pagesScanned: 1, statesObserved: 3, confirmedIssues: issues.length, needsReview: 1, evidenceScreenshots: 1, durationMs: 60000, byImpact: { serious: issues.length } },
    pages: [{ url, title: "Fixture application", depth: 0, issueIds: issues.map((entry) => entry.id), incompleteIds: incomplete.map((entry) => entry.id), observedStates: states, baseline: "evidence/baselines/fixture.png" }],
    graph: { nodes: [{ id: url, url, label: "Fixture application", depth: 0, state: "page", issueCount: issues.length, status: "scanned" }, ...states], edges: states.map((entry) => ({ source: url, target: entry.id, type: "click", label: `Open ${entry.label}` })) },
    issues, incomplete, events: [], acr: [{ criterion: "WCAG 1.1.1 Non-text Content", level: "A", status: "Does Not Support", issueCount: issues.length, remarks: "Fixture findings" }]
  };
}

export async function startDashboardFixture() {
  const reports = [makeReport("fixture-current", "fixture.test", "12"), makeReport("fixture-earlier", "fixture.test", "11", false),
    makeReport("other-current", "another.test", "10"), makeReport("other-earlier", "another.test", "09", false)];
  const empty = makeReport("fixture-empty", "empty.test", "08");
  empty.issues = []; empty.incomplete = []; empty.pages = []; empty.graph = { nodes: [], edges: [] }; empty.acr = [];
  empty.summary = { pagesScanned: 0, statesObserved: 0, confirmedIssues: 0, needsReview: 0, evidenceScreenshots: 0, durationMs: 0 };
  reports.push(empty);
  const app = express();
  app.get("/api/health", (_req, res) => res.json({ aiLoginAvailable: false, nvda: { available: false, reason: "Fixture server" } }));
  app.get("/api/reports", (_req, res) => res.json(reports));
  app.get("/api/reports/:id/compare/:previous", (req, res, next) => {
    try { res.json(compareReports(reports.find((entry) => entry.id === req.params.id), reports.find((entry) => entry.id === req.params.previous))); }
    catch (error) { next(error); }
  });
  app.get("/api/reports/:id/:section", (req, res) => {
    const report = reports.find((entry) => entry.id === req.params.id);
    if (!report) return res.status(404).json({ error: "Fixture report missing" });
    res.json(reportSection(report, req.params.section));
  });
  app.get("/api/reports/:id", (req, res) => {
    const report = reports.find((entry) => entry.id === req.params.id);
    if (!report) return res.status(404).json({ error: "Fixture report missing" });
    res.json(report);
  });
  app.use("/reports", (_req, res) => res.type("image/svg+xml").send('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="green"/></svg>'));
  app.use(express.static(fileURLToPath(new URL("../../public/", import.meta.url))));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, reports, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
