import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAudit, normalizeAuditConfiguration, validateAuditReview, GENERAL_CHECKS, FINANCIAL_CHECKS } from "../src/report/audit.js";
import { renderAcrCsv, renderAcrHtml, writeReportFiles } from "../src/report/export.js";

const report = (extra = {}) => ({ id: "audit-fixture", targetUrl: "https://example.test", configuration: { audit: { profile: "general", wcagVersion: "2.2", level: "AA" } }, issues: [], incomplete: [], pages: [], ...extra });
const decision = (extra = {}) => ({ kind: "criterion", targetId: "1.1.1", status: "Supports", reviewer: "Reviewer One", notes: "Inspected descriptive alternatives in the agreed scope", scope: "Staging build 12; Chrome; home and account pages", evidence: ["manual/run-12.txt"], ...extra });

test("general and financial profiles share WCAG coverage and add distinct financial review work", () => {
  const general = buildAudit(report());
  const financial = buildAudit(report({ configuration: { audit: { profile: "financial", wcagVersion: "2.2", level: "AA" } } }));
  assert.deepEqual(general.criteria.map((row) => row.id), financial.criteria.map((row) => row.id));
  assert.equal(general.checks.length, GENERAL_CHECKS.length);
  assert.equal(financial.checks.length, GENERAL_CHECKS.length + FINANCIAL_CHECKS.length);
  assert.ok(financial.checks.some((row) => row.id === "financial-payments"));
  assert.ok(!general.checks.some((row) => row.id.startsWith("financial-")));
  assert.ok(financial.checks.every((row) => row.status === "not-reviewed"));
  assert.match(financial.regulatoryNotice, /not a complete SEBI/);
  assert.equal(general.regulatoryNotice, null);
  assert.match(general.notice, /not an official ITI VPAT template/);
});

test("legacy reports default to a pending general WCAG 2.2 draft", () => {
  const audit = buildAudit({});
  assert.equal(audit.profile, "general");
  assert.equal(audit.wcagVersion, "2.2");
  assert.equal(audit.summary.criteriaTotal, 55);
  assert.equal(audit.summary.criteriaReviewed, 0);
  assert.equal(audit.methods.nvdaStatus, "not-run");
  assert.ok(audit.criteria.every((row) => row.status === "Not Evaluated"));
});

test("audit configuration rejects unsupported profiles, levels and malformed settings", () => {
  assert.deepEqual(normalizeAuditConfiguration(), { profile: "general", wcagVersion: "2.2", level: "AA" });
  for (const invalid of [null, [], "financial", { profile: "sebi-certified" }, { wcagVersion: "3.0" }, { level: "AAA" }]) assert.throws(() => normalizeAuditConfiguration(invalid));
});

test("WCAG 2.1 checklist omits new 2.2 mappings without pretending those checks ran", () => {
  const audit = buildAudit(report({ configuration: { audit: { profile: "general", wcagVersion: "2.1" } } }));
  assert.equal(audit.criteria.length, 50);
  assert.ok(audit.criteria.some((row) => row.id === "4.1.1"));
  assert.ok(audit.checks.every((row) => !row.criteria.includes("3.3.8") && !row.criteria.includes("2.5.8")));
});

test("rule pass observations and NVDA execution never auto-pass a criterion", () => {
  const audit = buildAudit(report({ pages: [{ url: "https://example.test", ruleOutcomes: [{ rules: [
    { id: "image-alt", wcag: ["1.1.1"], status: "pass" },
    { id: "image-alt", tags: ["wcag111"], status: "fail" },
    { id: "image-alt", wcag: ["1.1.1"], status: "needs-review" },
    { id: "image-alt", wcag: ["1.1.1"], status: "inapplicable" }
  ] }] }], assistiveTechnology: { actualRuns: { NVDA: { status: "executed", outcome: "completed" } } } }));
  const row = audit.criteria.find((entry) => entry.id === "1.1.1");
  assert.equal(row.status, "Not Evaluated");
  assert.deepEqual(row.automation, { pass: 1, fail: 1, "needs-review": 1, inapplicable: 1, observations: 4 });
  assert.equal(audit.methods.nvdaStatus, "executed");
  assert.equal(audit.methods.ruleObservations, 4);
});

test("review validation requires documentary evidence and generates server-owned identity", () => {
  const accepted = validateAuditReview(report(), decision({ id: "fake", at: "fake", reviewer: " Reviewer One ", evidence: ["manual/run-12.txt", "manual/run-12.txt"] }));
  assert.match(accepted.id, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(accepted.at)));
  assert.equal(accepted.reviewer, "Reviewer One");
  assert.deepEqual(accepted.evidence, ["manual/run-12.txt"]);
  for (const invalid of [null, [], {}, decision({ reviewer: "" }), decision({ notes: " " }), decision({ scope: "" }), decision({ evidence: [] }), decision({ evidence: [""] }), decision({ evidence: [2] }), decision({ notes: "bad\u0000text" }), decision({ targetId: "9.9.9" }), decision({ status: "certified" }), decision({ kind: "other" })]) {
    assert.throws(() => validateAuditReview(report(), invalid), (error) => error.status === 400);
  }
});

test("confirmed scan findings block a contradictory Supports or Not Applicable review", () => {
  const failed = report({ issues: [{ wcag: ["1.1.1"], impact: "minor" }] });
  for (const status of ["Supports", "Not Applicable"]) assert.throws(() => validateAuditReview(failed, decision({ status })), /Confirmed findings remain/);
  assert.equal(validateAuditReview(failed, decision({ status: "Partially Supports" })).status, "Partially Supports");
  assert.equal(validateAuditReview(failed, decision({ status: "Does Not Support" })).status, "Does Not Support");
});

test("reviews are scoped to the selected profile and do not mutate report evidence", () => {
  const source = report();
  const original = structuredClone(source);
  const reviewed = validateAuditReview(source, decision());
  assert.deepEqual(source, original);
  assert.throws(() => validateAuditReview(source, decision({ kind: "check", targetId: "financial-payments", status: "pass" })), /does not belong/);
  const audit = buildAudit({ ...source, auditReviews: [reviewed, validateAuditReview(source, decision({ kind: "check", targetId: "forms-errors", status: "pass" }))] });
  assert.equal(audit.summary.criteriaReviewed, 1);
  assert.equal(audit.summary.criteriaPending, 54);
  assert.equal(audit.summary.checksReviewed, 1);
  assert.equal(audit.criteria.find((row) => row.id === "3.3.1").status, "Not Evaluated");
});

test("HTML and CSV exports include reviews, explicit scope and financial limitations safely", () => {
  const source = report({ configuration: { audit: { profile: "financial", wcagVersion: "2.1", level: "AA" } }, targetUrl: "https://example.test/<script>alert(1)</script>" });
  source.auditReviews = [validateAuditReview(source, decision({ reviewer: "=HYPERLINK(\"https://example.test\")", notes: "<img src=x onerror=alert(1)>" }))];
  const html = renderAcrHtml(source);
  const csv = renderAcrCsv(source);
  assert.match(html, /WCAG 2.1 AA/);
  assert.match(html, /financial|Financial/);
  assert.match(html, /not a complete SEBI/);
  assert.match(html, /manual\/run-12.txt/);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;img/);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.match(csv, /Financial|financial/);
  assert.match(csv, /Not Evaluated/);
  assert.match(csv, /manual\/run-12.txt/);
});

test("report files preserve configuration, all criterion rows and pending review status", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "accessibility-audit-export-"));
  try {
    const source = report({ configuration: { audit: { profile: "financial", wcagVersion: "2.1", level: "AA" } } });
    await writeReportFiles(source, directory);
    const persisted = JSON.parse(await fs.readFile(path.join(directory, "vpat_draft.json"), "utf8"));
    assert.equal(persisted.audit.profile, "financial");
    assert.equal(persisted.acr.length, 50);
    assert.ok(persisted.acr.every((row) => row.status === "Not Evaluated"));
    assert.match(await fs.readFile(path.join(directory, "ACR_VPAT_Report.csv"), "utf8"), /financial-payments/);
    assert.match(await fs.readFile(path.join(directory, "ACR_VPAT_Report.html"), "utf8"), /working draft/);
  } finally {
    // Only remove the exact temporary test directory created above.
    await fs.rm(directory, { recursive: true, force: true });
  }
});
