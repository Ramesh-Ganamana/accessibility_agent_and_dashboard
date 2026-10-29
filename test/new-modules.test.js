import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backlogHost, backlogItemKey, renderBacklogCsv, summarizeBacklog } from "../src/report/backlog.js";
import { complianceForReport, findComplianceItem, importComplianceSet, listComplianceSets } from "../src/report/compliance.js";
import { consequentialGuard, originAllowed, resolveValue, validateJourney } from "../src/journeys/journey.js";
import { EN_301_549, SECTION_508, VPAT_ROW_IDS, findVpatRow } from "../src/report/vpat.js";
import { documentType } from "../src/scanner/documents.js";

test("backlog keys are stable per rule, element and route, and site-wide for shared navigation", () => {
  const finding = { ruleId: "image-alt", target: ["#logo"], pageUrl: "https://bank.test/accounts?tab=1#/summary" };
  assert.equal(backlogItemKey(finding), backlogItemKey({ ...finding, impact: "minor", id: "other-id" }), "ids and impact do not change the key");
  assert.notEqual(backlogItemKey(finding), backlogItemKey({ ...finding, pageUrl: "https://bank.test/cards" }));
  assert.equal(backlogItemKey({ ...finding, region: "global" }), backlogItemKey({ ...finding, region: "global", pageUrl: "https://bank.test/cards" }), "shared navigation is one item for the site");
  assert.equal(backlogHost("https://Bank.Test/x"), "bank.test");
  assert.equal(backlogHost("not a url"), "");
});

test("backlog summary counts open, reopened and unverified absences; CSV neutralises formulas", () => {
  const items = [
    { status: "open", latestScan: "present" }, { status: "fixed", latestScan: "not-found" }, { status: "verified", latestScan: "not-found" },
    { status: "reopened", latestScan: "present" }, { status: "wont-fix", latestScan: "not-found" }
  ].map((item, index) => ({ wcag: ["1.1.1"], help: index === 0 ? "=cmd|' /C calc'!A0" : "Issue", ruleId: "r", target: "#a", ...item }));
  const summary = summarizeBacklog({ items });
  assert.equal(summary.total, 5);
  assert.equal(summary.reopened, 1);
  assert.equal(summary.notFoundAwaitingVerification, 1, "only the fixed item awaits verification");
  assert.match(renderBacklogCsv({ items }), /'=cmd/);
});

test("compliance sets: built-in sources, imports and decisions per report", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compliance-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const builtIn = listComplianceSets(dir);
  assert.deepEqual(builtIn.sets.map((set) => set.id), ["gigw-3.0", "sebi-digital-accessibility"]);
  await importComplianceSet(dir, { id: "is-17802-part-1", title: "IS 17802 (licensed copy)", items: [{ reference: "C-1", requirement: "Licensed clause text", wcag: "1.1.1, 4.1.2" }] });
  const item = findComplianceItem(dir, "is-17802-part-1::c-1-1");
  assert.deepEqual([item.reference, item.wcag, item.confidence], ["C-1", ["1.1.1", "4.1.2"], "imported"]);
  assert.equal(findComplianceItem(dir, "is-17802-part-1::missing"), null);
  const report = {
    audit: { criteria: [{ id: "1.1.1", status: "Does Not Support", issueCount: 2 }] },
    auditReviews: [
      { kind: "compliance-item", targetId: "is-17802-part-1::c-1-1", status: "met", reviewer: "A", notes: "n", scope: "s", evidence: ["e"] },
      { kind: "compliance-item", targetId: "is-17802-part-1::c-1-1", status: "not-met", reviewer: "B", notes: "retest failed", scope: "s", evidence: ["e"] },
      { kind: "compliance-item", targetId: "gigw-3.0::3-3-1", status: "met", reviewer: "", notes: "", scope: "", evidence: [] }
    ]
  };
  const compliance = complianceForReport(dir, report);
  const imported = compliance.sets.find((set) => set.id === "is-17802-part-1");
  assert.equal(imported.items[0].status, "not-met", "the latest decision wins");
  assert.deepEqual(imported.items[0].relatedWcag[0], { id: "1.1.1", status: "Does Not Support", findings: 2 });
  assert.equal(compliance.sets.find((set) => set.id === "gigw-3.0").summary.reviewed, 0, "an undocumented decision is not counted");
});

test("journey rules: masking, origin scope and the consequential guard", () => {
  assert.deepEqual(resolveValue("{{email}}", { email: "a@b.test" }), { resolved: "a@b.test", masked: "{{email}}" });
  assert.deepEqual(resolveValue("1 Test Street", {}), { resolved: "1 Test Street", masked: "(literal value)" });
  assert.throws(() => resolveValue("{{missing}}", {}), /missing from the test-data file/);
  const journey = { environment: "sandbox", allowedOrigins: ["https://app.test/"], authorization: { reference: "TP-1" } };
  assert.equal(originAllowed("https://app.test/x", journey), true);
  assert.equal(originAllowed("https://app.test.evil.example/x", journey), false);
  assert.match(consequentialGuard({}, "Submit payment", journey), /Mark the step "consequential"/);
  assert.equal(consequentialGuard({ consequential: true }, "Submit payment", journey), null);
  assert.match(consequentialGuard({ consequential: true }, "Submit payment", { ...journey, environment: "production-read-only" }), /production-read-only/);
  assert.equal(consequentialGuard({}, "Statements", journey), null);
  assert.ok(validateJourney({ name: "x", environment: "sandbox", startUrl: "https://app.test/", allowedOrigins: ["https://app.test"], device: "watch", steps: [{ action: "checkpoint", name: "a" }] }).some((error) => /device/.test(error)));
});

test("VPAT 508 and EN 301 549 rows and document detection", () => {
  const rows = [...SECTION_508, ...EN_301_549].flatMap((chapter) => chapter.rows);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, "row ids are unique");
  assert.equal(VPAT_ROW_IDS.size, rows.length);
  assert.ok(findVpatRow("508-302.1"));
  assert.equal(findVpatRow("508-999"), null);
  assert.equal(documentType("https://bank.test/files/Statement.PDF?token=x"), "pdf");
  assert.equal(documentType("https://bank.test/statement"), null);
  assert.equal(documentType("nonsense"), null);
});

test("a start address that redirects to the www or https origin moves the crawl scope; other redirects do not", async () => {
  const { adoptRedirectedOrigin } = await import("../src/scanner/crawler.js");
  const scope = (targetUrl, actualUrl) => {
    const report = { targetUrl, configuration: { excludedActionOrigin: new URL(targetUrl).origin } };
    const config = { excludeActionOrigin: new URL(targetUrl).origin };
    const moved = adoptRedirectedOrigin(report, config, actualUrl);
    return { moved, targetUrl: report.targetUrl, exclusions: config.excludeActionOrigin, recorded: report.configuration.excludedActionOrigin };
  };
  assert.deepEqual(scope("https://feuji.com/", "https://www.feuji.com/"), { moved: true, targetUrl: "https://www.feuji.com/", exclusions: "https://www.feuji.com", recorded: "https://www.feuji.com" });
  assert.equal(scope("https://www.bank.test/app?x=1", "https://bank.test/home").targetUrl, "https://bank.test/app?x=1");
  assert.equal(scope("http://bank.test/", "https://bank.test/").moved, true, "an https upgrade is followed");
  assert.equal(scope("https://bank.test/", "http://bank.test/").moved, false, "a downgrade to http is not followed");
  assert.equal(scope("https://bank.test/", "https://login.bank.test/").moved, false, "a sign-in subdomain does not become the scope");
  assert.equal(scope("https://bank.test/", "https://other.test/").moved, false);
  assert.equal(scope("https://bank.test/", "https://bank.test/dashboard").moved, false, "same origin needs no change");
});
