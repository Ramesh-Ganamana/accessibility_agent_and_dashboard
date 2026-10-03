import test from "node:test";
import assert from "node:assert/strict";
import { assessReport, reportSection } from "../src/report/assessment.js";

function report(issues = [], incomplete = []) {
  return {
    id: "scan-1", targetUrl: "https://example.test", completedAt: "2026-09-22T10:00:00Z",
    pages: [{ url: "https://example.test", error: null }],
    summary: { statesObserved: 2 }, issues, incomplete,
    graph: { nodes: [{ id: "home" }], edges: [] }, events: [], acr: []
  };
}

test("a clean observed scan scores 10 but remains explicitly provisional", () => {
  const result = assessReport(report());
  assert.equal(result.score, 10);
  assert.equal(result.grade, "A+");
  assert.equal(result.status, "provisional");
  assert.match(result.methodology.note, /not a WCAG conformance score/i);
});

test("confirmed severity lowers the score; uncertain items change confidence, not proven failures", () => {
  const issue = { impact: "critical", wcag: ["1.1.1"] };
  const confirmed = assessReport(report([issue]));
  const uncertain = assessReport(report([issue], [{ impact: "serious", wcag: ["2.4.7"] }]));
  assert.ok(confirmed.score < 10);
  assert.equal(confirmed.principles[0].confirmedIssues, 1);
  assert.equal(confirmed.principles[1].confirmedIssues, 0);
  assert.equal(uncertain.score, confirmed.score);
  assert.equal(uncertain.confidence, "Limited");
  assert.equal(uncertain.counts.needsReview, 1);
});

test("unscanned reports do not receive a misleading grade", () => {
  const empty = report();
  empty.pages = [{ url: empty.targetUrl, error: "Forbidden" }];
  assert.equal(assessReport(empty).score, null);
  assert.equal(assessReport(empty).grade, "—");
});

test("dashboard sections expose existing report data without changing the canonical report", () => {
  const source = report([{ id: "issue-1", impact: "moderate", evidence: "evidence/0001.png" }]);
  assert.equal(reportSection(source, "overview").assessment.outOf, 10);
  assert.equal(reportSection(source, "score").grade, assessReport(source).grade);
  assert.equal(reportSection(source, "issues").confirmed.length, 1);
  assert.equal(reportSection(source, "evidence").items[0].evidence, "evidence/0001.png");
  assert.equal(reportSection(source, "evidence").items[0].evidenceUrl, "/reports/scan-1/evidence/0001.png");
  assert.deepEqual(reportSection(source, "graph"), source.graph);
  assert.equal(reportSection(source, "unknown"), null);
});
