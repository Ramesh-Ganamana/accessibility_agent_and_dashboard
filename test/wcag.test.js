import test from "node:test";
import assert from "node:assert/strict";
import { buildAcrRows, criteriaForVersion, criteriaFromTags, formatTarget, statusForCriteria, WCAG_REGISTRY } from "../src/scanner/wcag.js";

const review = (status, extra = {}) => ({ kind: "criterion", targetId: "1.1.1", status, reviewer: "Accessibility reviewer", scope: "Test build, all agreed image states", notes: "Manually verified the alternatives", evidence: ["test-run-17"], ...extra });

test("registry contains all 50 WCAG 2.1 and 55 WCAG 2.2 A/AA criteria", () => {
  const earlier = criteriaForVersion("2.1");
  const later = criteriaForVersion("2.2");
  assert.equal(earlier.length, 50);
  assert.equal(later.length, 55);
  assert.ok(earlier.some((row) => row.id === "4.1.1"));
  assert.ok(!later.some((row) => row.id === "4.1.1"));
  assert.deepEqual(later.filter((row) => row.since === "2.2").map((row) => row.id), ["2.4.11", "2.5.7", "2.5.8", "3.2.6", "3.3.7", "3.3.8"]);
  assert.equal(new Set(Object.values(WCAG_REGISTRY).map((row) => row.id)).size, 56);
  assert.ok([...earlier, ...later].every((row) => ["A", "AA"].includes(row.level) && row.name && row.sourceUrl.startsWith("https://www.w3.org/")));
  assert.throws(() => criteriaForVersion("3.0"), /WCAG version/);
});

test("maps axe tags to stable WCAG criterion identifiers", () => {
  assert.deepEqual(criteriaFromTags(["wcag2a", "wcag111", "wcag143", "wcag111", "wcag134", "wcag2411", "wcag258", "wcag338", "wcag999"]), ["1.1.1", "1.4.3", "1.3.4", "2.4.11", "2.5.8", "3.3.8"]);
  assert.deepEqual(criteriaFromTags(null), []);
  assert.deepEqual(criteriaFromTags("wcag111"), []);
});

test("automated severity never establishes criterion conformance", () => {
  for (const impact of ["minor", "moderate", "serious", "critical"]) assert.equal(statusForCriteria([{ impact }]), "Not Evaluated");
  assert.equal(statusForCriteria([]), "Not Evaluated");
  assert.equal(statusForCriteria([], review("Supports")), "Supports");
  assert.equal(statusForCriteria([{}], review("Partially Supports")), "Partially Supports");
  assert.equal(statusForCriteria([{}], review("Does Not Support")), "Does Not Support");
  assert.equal(statusForCriteria([], review("Not Applicable")), "Not Applicable");
});

test("undocumented and evidence-conflicting decisions remain pending", () => {
  for (const field of ["reviewer", "scope", "notes"]) assert.equal(statusForCriteria([], review("Supports", { [field]: " " })), "Not Evaluated");
  assert.equal(statusForCriteria([], review("Supports", { evidence: [] })), "Not Evaluated");
  assert.equal(statusForCriteria([], review("Passed")), "Not Evaluated");
  for (const status of ["Supports", "Not Applicable"]) assert.equal(statusForCriteria([{}], review(status)), "Not Evaluated");
});

test("formats shadow selectors as a readable target path", () => {
  assert.equal(formatTarget([["product-card", "#buy"]]), "product-card → #buy");
});

test("builds ACR rows with affected selectors", () => {
  const rows = buildAcrRows([{ impact: "critical", help: "Images need alt text", target: ["#hero"], wcag: ["1.1.1"] }]);
  const nonText = rows.find((row) => row.criterion.startsWith("WCAG 1.1.1"));
  assert.equal(nonText.status, "Not Evaluated");
  assert.match(nonText.remarks, /#hero/);
});

test("latest scoped review controls a criterion and version-specific source links", () => {
  const rows = buildAcrRows([], [], { wcagVersion: "2.1", reviews: [review("Supports"), review("Not Applicable", { notes: "No non-text content exists in the declared scope" })] });
  const nonText = rows.find((row) => row.id === "1.1.1");
  assert.equal(rows.length, 50);
  assert.equal(nonText.status, "Not Applicable");
  assert.match(nonText.sourceUrl, /WCAG21/);
  assert.equal(nonText.reviewStatus, "reviewed");
});

test("ACR does not claim support from missing failures or unresolved review findings", () => {
  const rows = buildAcrRows([], [{ wcag: ["1.4.3"], impact: "serious" }]);
  const contrast = rows.find((row) => row.criterion.startsWith("WCAG 1.4.3"));
  assert.equal(contrast.status, "Not Evaluated");
  assert.equal(contrast.needsReviewCount, 1);
  assert.match(contrast.remarks, /human review/);
  assert.ok(rows.every((row) => row.status !== "Supports"));
});

