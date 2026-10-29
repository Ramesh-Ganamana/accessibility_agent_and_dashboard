import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isUnsafeActionLabel, isUnsafeControlLabel } from "../src/scanner/actions.js";
import { isAuthenticationRoute } from "../src/browser/session.js";
import { localRequestGuard, updateJobFromEvent, settleJob, STOPPED_PHASE } from "../src/server.js";
import { listReports, readReport } from "../src/report/store.js";
import { syncBacklog } from "../src/report/backlog.js";
import { selectReportsToPrune } from "../scripts/prune-reports.js";
import { assessReport } from "../src/report/assessment.js";
import { compareReports } from "../src/report/comparison.js";
import { writeReportCheckpoint } from "../src/report/export.js";
import { summarizeTiming } from "../src/assistive-technology/nvda-live.js";
import { getConfig } from "../src/config.js";

test("destructive labels are recognized in common non-English languages", () => {
  for (const label of ["Löschen", "Überweisen", "Supprimer le compte", "Eliminar", "Excluir", "Verwijderen", "हटाएं", "भुगतान करें", "Se déconnecter"]) {
    assert.equal(isUnsafeActionLabel(label), true, label);
  }
  for (const label of ["Archive conversation", "Revoke access", "Mark all as read", "Close account", "Duplicate project", "Leave group"]) {
    assert.equal(isUnsafeActionLabel(label), true, label);
  }
  for (const label of ["Services", "Order history", "Leave policy", "Download centre", "Überblick", "Paiements récents"]) {
    assert.equal(isUnsafeActionLabel(label), false, label);
  }
});

test("short imperative words block buttons but not navigation links", () => {
  for (const label of ["Leave", "Download", "Start", "Accept", "Follow", "Print"]) assert.equal(isUnsafeControlLabel(label), true, label);
  for (const label of ["View details", "Open menu", "Services", "Next"]) assert.equal(isUnsafeControlLabel(label), false, label);
  assert.equal(isUnsafeActionLabel("Leave"), false, "a Leave link in an HR menu is navigation");
});

test("credentials are only entered on authentication routes", () => {
  const config = { targetUrl: "https://app.example/home", login: { url: "https://app.example/signin" } };
  assert.equal(isAuthenticationRoute("https://app.example/tenant-login", config), true);
  assert.equal(isAuthenticationRoute("https://app.example/signin", config), true);
  assert.equal(isAuthenticationRoute("https://idp.example/authorize", config), true, "an external identity provider is an authentication route");
  for (const url of ["https://app.example/users/new", "https://app.example/settings/security", "https://app.example/register"]) {
    assert.equal(isAuthenticationRoute(url, config), false, url);
  }
});

test("the dashboard rejects rebinding hostnames and cross-origin writes", () => {
  const run = (method, headers) => {
    let status = null;
    let passed = false;
    const response = { status: (code) => { status = code; return { json: () => {} }; } };
    localRequestGuard({ method, headers }, response, () => { passed = true; });
    return passed ? "next" : status;
  };
  assert.equal(run("GET", { host: "localhost:4173" }), "next");
  assert.equal(run("GET", { host: "127.0.0.1:4173" }), "next");
  assert.equal(run("GET", { host: "[::1]:4173" }), "next");
  assert.equal(run("GET", { host: "attacker.example:4173" }), 421);
  assert.equal(run("POST", { host: "localhost:4173", origin: "https://attacker.example" }), 403);
  assert.equal(run("POST", { host: "localhost:4173", origin: "http://localhost:4173" }), "next");
  assert.equal(run("POST", { host: "localhost:4173" }), "next", "same-origin tools without an Origin header still work");
});

test("older reports present best-practice rules separately without rewriting the file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-fixes-store-"));
  try {
    const id = "legacy-report";
    await fs.mkdir(path.join(root, id));
    const original = JSON.stringify({
      id, targetUrl: "https://example.test", startedAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T00:01:00Z",
      pages: [{ url: "https://example.test" }], incomplete: [],
      issues: [
        { id: "a", ruleId: "image-alt", wcag: ["1.1.1"], tags: ["wcag2a", "wcag111"], impact: "serious" },
        { id: "b", ruleId: "region", wcag: [], tags: ["cat.keyboard", "best-practice"], impact: "moderate" }
      ]
    });
    await fs.writeFile(path.join(root, id, "vpat_draft.json"), original);
    const report = await readReport(root, id);
    assert.deepEqual(report.issues.map((issue) => issue.id), ["a"]);
    assert.deepEqual(report.bestPractices.map((issue) => issue.id), ["b"]);
    report.issues.push({ id: "mutated" });
    assert.deepEqual((await readReport(root, id)).issues.map((issue) => issue.id), ["a"], "cached reports are returned as copies");
    assert.equal(await fs.readFile(path.join(root, id, "vpat_draft.json"), "utf8"), original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("checkpoints save partial reports that list as in progress", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-fixes-checkpoint-"));
  try {
    const report = { id: "partial-1", targetUrl: "https://example.test", startedAt: "2026-10-02T00:00:00Z", completedAt: null, status: "in-progress", pages: [{ url: "https://example.test" }], issues: [], incomplete: [], summary: {} };
    await writeReportCheckpoint(report, path.join(root, report.id));
    const [listed] = await listReports(root);
    assert.equal(listed.status, "in-progress");
    assert.equal(listed.summary.pagesScanned, 1);
    assert.equal((await readReport(root, report.id)).status, "in-progress");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a stopped checkpoint lists as stopped and never updates the backlog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-fixes-stopped-"));
  try {
    const pageUrl = "https://stopped.example.test/";
    const report = {
      id: "stopped-1", targetUrl: pageUrl, startedAt: "2026-10-03T00:00:00Z", completedAt: null, stoppedAt: "2026-10-03T00:02:00Z", status: "stopped",
      stopReason: { code: "TEST_BROWSER_CLOSED", message: "The test browser was closed." }, pages: [{ url: pageUrl }],
      issues: [{ id: "a", ruleId: "image-alt", wcag: ["1.1.1"], impact: "serious", pageUrl, target: ["img"] }], incomplete: [], summary: {}
    };
    await writeReportCheckpoint(report, path.join(root, report.id));
    const [listed] = await listReports(root);
    assert.equal(listed.status, "stopped");
    assert.equal(listed.completedAt, null, "a stopped scan stays out of scores and comparisons");
    assert.equal(listed.summary.pagesScanned, 1);
    const saved = await readReport(root, report.id);
    assert.equal(saved.status, "stopped");
    assert.equal(saved.stopReason.code, "TEST_BROWSER_CLOSED");
    const result = await syncBacklog(root, saved);
    assert.equal(result.added, 0);
    assert.match(result.skipped, /stopped/);
    await assert.rejects(fs.access(path.join(root, "_backlog")), { code: "ENOENT" }, "a partial scan must not write the backlog");
    assert.equal((await syncBacklog(root, { ...saved, id: "complete-1", status: "complete" })).added, 1, "the same findings sync from a completed scan");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("browser-closed, NVDA pause and new-tab events change the phase without warnings or progress", () => {
  const job = { status: "running", phase: "Scanning application", progress: 40, warningCount: 0, currentUrl: "https://app.test/a", reportId: null, events: [] };
  for (const [event, phase] of [
    [{ type: "nvda-paused", message: "NVDA paused: focus left the test tab." }, /NVDA paused/],
    [{ type: "nvda-resumed", message: "NVDA resumed." }, /NVDA resumed/],
    [{ type: "tab-external", url: "https://partner.example/offer", message: "External tab recorded." }, /External tab recorded/],
    [{ type: "tab-returned-home", url: "https://app.test/popup", message: "Returned to the home tab." }, /home tab/],
    [{ type: "crawl-termination", reason: "test_browser_closed", message: "The test browser was closed." }, /Test browser closed — partial coverage/],
    [{ type: "browser-closed", message: "The test browser was closed; the scan is stopping and keeps the results so far." }, /saving partial report/],
    [{ type: "scan-stopped", reportId: "report-stopped", message: "Scan stopped." }, new RegExp(STOPPED_PHASE)]
  ]) {
    updateJobFromEvent(job, { at: new Date().toISOString(), ...event });
    assert.match(job.phase, phase, event.type);
  }
  assert.equal(job.warningCount, 0, "routine recoveries are not warnings");
  assert.equal(job.progress, 40, "progress stays monotonic");
  assert.equal(job.currentUrl, "https://app.test/a", "an external or closed tab is not the page being scanned");
  assert.equal(job.reportId, "report-stopped");
  updateJobFromEvent(job, { type: "nvda-warning", message: "NVDA stopped." });
  assert.equal(job.warningCount, 1, "a real NVDA warning still counts");
});

test("a stopped scan settles as a terminal partial job without an error or backlog sync", () => {
  const job = { status: "running", phase: "Scanning application", progress: 57, events: [], reportId: "r-2", error: null, warningCount: 0 };
  const synced = settleJob(job, { id: "r-2", status: "stopped", stoppedAt: "2026-10-15T00:00:00Z", stopReason: { code: "TEST_BROWSER_CLOSED", message: "The test browser was closed." }, pages: [{}, {}] });
  assert.equal(synced, false, "a partial scan must not update the backlog");
  assert.equal(job.status, "stopped");
  assert.equal(job.phase, STOPPED_PHASE);
  assert.equal(job.progress, 57, "the last known progress is kept");
  assert.equal(job.error, null, "a user stop is not a failure");
  assert.equal(job.stopReason, "The test browser was closed.");
  assert.equal(job.stoppedAt, "2026-10-15T00:00:00Z");
  assert.equal(job.events.at(-1).type, "stopped");
  assert.match(job.events.at(-1).message, /test browser was closed.*2 scanned pages/);
  const complete = { status: "running", phase: "Scanning application", progress: 80, events: [], reportId: null, error: null };
  assert.equal(settleJob(complete, { id: "r-3", status: "complete" }), true);
  assert.deepEqual([complete.status, complete.progress, complete.reportId], ["complete", 100, "r-3"]);
});

test("NVDA recovery failure settles as a partial scan, not a completed scan or browser closure", () => {
  const job = { status: "running", progress: 57, events: [], error: null };
  assert.equal(settleJob(job, { id: "nvda-partial", status: "stopped", stopReason: {
    code: "NVDA_INTERRUPTED", message: "NVDA could not recover the same state."
  }, pages: [{}] }), false);
  assert.equal(job.status, "stopped");
  assert.equal(job.progress, 57);
  assert.match(job.phase, /NVDA interrupted/);
  assert.doesNotMatch(job.events[0].message, /browser was closed/);
  updateJobFromEvent(job, { type: "scan-stopped", reason: "nvda_interrupted" });
  assert.match(job.phase, /NVDA interrupted/);
});

test("prune keeps stopped scans like interrupted ones unless --include-interrupted is passed", () => {
  const reports = [
    { id: "newest", host: "a.test", startedAt: 5, status: "complete" },
    { id: "stopped", host: "a.test", startedAt: 4, status: "stopped" },
    { id: "running", host: "a.test", startedAt: 3, status: "in-progress" },
    { id: "failed", host: "a.test", startedAt: 2, status: "failed" },
    { id: "old-complete", host: "a.test", startedAt: 1, status: "complete" }
  ];
  assert.deepEqual(selectReportsToPrune(reports, { keep: 1 }).map((report) => report.id).sort(), ["failed", "old-complete"]);
  assert.deepEqual(selectReportsToPrune(reports, { keep: 1, includeInterrupted: true }).map((report) => report.id).sort(), ["failed", "old-complete", "running", "stopped"]);
  assert.deepEqual(selectReportsToPrune([{ id: "only", host: "b.test", startedAt: 1, status: "stopped" }], { keep: 1, includeInterrupted: true }), [], "the newest report of a site is always kept");
});

test("the score does not improve by recording more duplicate interaction states", () => {
  const base = (observedStates) => ({
    completedAt: "2026-10-01T00:00:00Z",
    pages: [{ url: "https://example.test", observedStates: Array.from({ length: observedStates }, (_, index) => ({ id: `s${index}` })) }],
    issues: [{ impact: "serious", wcag: ["1.4.3"] }, { impact: "moderate", wcag: [], tags: ["best-practice"] }],
    incomplete: []
  });
  const few = assessReport(base(1));
  const many = assessReport(base(90));
  assert.equal(many.score, few.score);
  assert.equal(few.counts.confirmedIssues, 1, "best-practice rules are not confirmed WCAG findings");
  assert.equal(few.counts.bestPractices, 1);
  assert.equal(few.methodology.version, 2);
});

test("a shared navigation finding is unresolved, not new and fixed, when crawl order changes", () => {
  const finding = (pageUrl, otherUrl) => ({ ruleId: "color-contrast", wcag: ["1.4.3"], target: ["header > a"], region: "global", pageUrl, frameUrl: pageUrl, state: "default", alsoObservedOn: [{ pageUrl: otherUrl, state: "default" }] });
  const report = (id, startedAt, first, second) => ({
    id, targetUrl: "https://example.test", startedAt, completedAt: startedAt,
    pages: [{ url: "https://example.test/a" }, { url: "https://example.test/b" }],
    issues: [finding(first, second)], incomplete: []
  });
  const previous = report("previous", "2026-10-01T00:00:00Z", "https://example.test/a", "https://example.test/b");
  const current = report("current", "2026-10-02T00:00:00Z", "https://example.test/b", "https://example.test/a");
  const comparison = compareReports(current, previous);
  assert.equal(comparison.counts.new, 0);
  assert.equal(comparison.counts.fixed, 0);
  assert.equal(comparison.counts.unresolved, 2);
});

test("NVDA timing summary reports the median of each command phase", () => {
  const timing = summarizeTiming([
    { kind: "focus", timing: { totalMs: 900, speechMs: 300 } },
    { kind: "focus", timing: { totalMs: 1200, speechMs: 400 } },
    { kind: "focus", timing: { totalMs: 3000, speechMs: 2000 } },
    { kind: "headings" }
  ]);
  assert.equal(timing.focus.commands, 3);
  assert.equal(timing.focus.totalMs, 1200);
  assert.equal(timing.focus.speechMs, 400);
  assert.equal(timing.headings, undefined);
});

test("AI checks are opt-in and saved sessions live outside the project folder", () => {
  const previous = { key: process.env.OPENAI_API_KEY, enabled: process.env.AI_ENABLED };
  try {
    process.env.OPENAI_API_KEY = "fixture-key";
    delete process.env.AI_ENABLED;
    const config = getConfig();
    assert.equal(config.aiEnabled, false, "an API key alone must not send page data to a model");
    process.env.AI_ENABLED = "true";
    assert.equal(getConfig().aiEnabled, true);
    assert.notEqual(path.dirname(config.authStatePath), config.rootDir, "new sessions are not saved in the project root");
    assert.equal(path.dirname(config.legacyAuthStatePath), config.rootDir, "sessions saved by earlier versions are still found");
  } finally {
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.key;
    if (previous.enabled === undefined) delete process.env.AI_ENABLED; else process.env.AI_ENABLED = previous.enabled;
  }
});
