import test from "node:test";
import assert from "node:assert/strict";
import { buildAcrRows, criteriaFromTags, formatTarget, statusForCriteria } from "../src/scanner/wcag.js";

test("maps axe tags to stable WCAG criterion identifiers", () => {
  assert.deepEqual(criteriaFromTags(["wcag2a", "wcag111", "wcag143", "wcag111"]), ["1.1.1", "1.4.3"]);
});

test("uses the most conservative VPAT status for serious findings", () => {
  assert.equal(statusForCriteria([]), "Supports");
  assert.equal(statusForCriteria([{ impact: "minor" }]), "Partially Supports");
  assert.equal(statusForCriteria([{ impact: "serious" }]), "Does Not Support");
});

test("formats shadow selectors as a readable target path", () => {
  assert.equal(formatTarget([["product-card", "#buy"]]), "product-card → #buy");
});

test("builds ACR rows with affected selectors", () => {
  const rows = buildAcrRows([{ impact: "critical", help: "Images need alt text", target: ["#hero"], wcag: ["1.1.1"] }]);
  const nonText = rows.find((row) => row.criterion.startsWith("WCAG 1.1.1"));
  assert.equal(nonText.status, "Does Not Support");
  assert.match(nonText.remarks, /#hero/);
});

