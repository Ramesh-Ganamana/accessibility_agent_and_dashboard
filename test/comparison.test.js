import test from "node:test";
import assert from "node:assert/strict";
import { compareReports } from "../src/report/comparison.js";

function report(id, targetUrl, startedAt, issues = [], options = {}) {
  return {
    id, targetUrl, startedAt, completedAt: startedAt,
    pages: (options.pages || [targetUrl]).map((url) => ({ url, error: null, observedStates: [] })),
    issues, incomplete: options.incomplete || []
  };
}

function finding(ruleId, criterion, target, pageUrl = "https://app.example.test/products", state = "default") {
  return { ruleId, wcag: [criterion], target: [target], pageUrl, state, help: ruleId };
}

const older = "2026-09-18T00:00:00.000Z";
const newer = "2026-09-19T00:00:00.000Z";
const site = "https://app.example.test";
const products = `${site}/products`;

test("rejects historical reports from a different hostname before producing a delta", () => {
  const current = report("current", site, newer);
  const previous = report("previous", "https://another.example.test", older);
  assert.throws(() => compareReports(current, previous), (error) => error.status === 409 && /Cross-site report comparison is not allowed/.test(error.message));
});

test("classifies matching criterion-rule-element failures as unresolved and changed elements as new or fixed", () => {
  const previous = report("previous", site, older, [
    finding("color-contrast", "1.4.3", ".old-label"),
    finding("image-alt", "1.1.1", "#shared-image")
  ], { pages: [products] });
  const current = report("current", site, newer, [
    finding("image-alt", "1.1.1", "#shared-image"),
    finding("color-contrast", "1.4.3", ".new-label")
  ], { pages: [products] });
  const comparison = compareReports(current, previous);
  assert.deepEqual(comparison.counts, { new: 1, fixed: 1, unresolved: 1 });
  assert.equal(comparison.groups.new[0].target, ".new-label");
  assert.equal(comparison.groups.fixed[0].target, ".old-label");
  assert.equal(comparison.groups.unresolved[0].criterion, "1.1.1");
});

test("keeps each execution's crawl graph separate in the comparison response", () => {
  const previous = { ...report("previous", site, older), graph: { nodes: [{ id: "before", label: "Before", depth: 0 }], edges: [] } };
  const current = { ...report("current", site, newer), graph: { nodes: [{ id: "after", label: "After", depth: 0 }], edges: [] } };
  const comparison = compareReports(current, previous);
  assert.deepEqual(comparison.graphs.previous.nodes.map((node) => node.id), ["before"]);
  assert.deepEqual(comparison.graphs.current.nodes.map((node) => node.id), ["after"]);
});

test("links each finding to its own scan's saved screenshot, including both sides of unresolved issues", () => {
  const previous = report("previous", site, older, [
    { ...finding("color-contrast", "1.4.3", ".fixed"), evidence: "evidence/0001-fixed.png" },
    { ...finding("image-alt", "1.1.1", ".shared"), evidence: "evidence/0002-shared.png" }
  ], { pages: [products] });
  const current = report("current", site, newer, [
    { ...finding("color-contrast", "1.4.3", ".new"), evidence: "evidence/0003-new.png" },
    { ...finding("image-alt", "1.1.1", ".shared"), evidence: "evidence/0004-shared.png" }
  ], { pages: [products] });
  const comparison = compareReports(current, previous);
  assert.equal(comparison.groups.new[0].evidence.url, "/reports/current/evidence/0003-new.png");
  assert.equal(comparison.groups.fixed[0].evidence.url, "/reports/previous/evidence/0001-fixed.png");
  assert.equal(comparison.groups.unresolved[0].previousEvidence.url, "/reports/previous/evidence/0002-shared.png");
  assert.equal(comparison.groups.unresolved[0].evidence.url, "/reports/current/evidence/0004-shared.png");
});

test("does not expose arbitrary file paths as screenshot links", () => {
  const current = report("current", site, newer, [{ ...finding("color-contrast", "1.4.3", ".label"), evidence: "../secrets.txt" }], { pages: [products] });
  const previous = report("previous", site, older, [], { pages: [products] });
  assert.equal(compareReports(current, previous).groups.new[0].evidence, null);
});

test("uses a saved page capture only as labeled context when the other scan has no matching failure", () => {
  const previous = report("previous", site, older, [], { pages: [products] });
  previous.pages[0].baseline = "evidence/baselines/001-products.png";
  const current = report("current", site, newer, [
    { ...finding("color-contrast", "1.4.3", ".label"), evidence: "evidence/0002-contrast.png" }
  ], { pages: [products] });
  const comparison = compareReports(current, previous);
  assert.equal(comparison.groups.new[0].previousEvidence.url, "/reports/previous/evidence/baselines/001-products.png");
  assert.equal(comparison.groups.new[0].previousEvidence.kind, "page-context");
  assert.equal(comparison.groups.new[0].evidence.kind, "highlighted");
  previous.pages[0].actualUrl = `${site}/sign-in`;
  assert.equal(compareReports(current, previous).groups.new[0].previousEvidence, null,
    "a screenshot taken after redirect must not be presented as context for the requested page");
});

test("does not infer a fix from a page that was not crawled or a rule needing review", () => {
  const previous = report("previous", site, older, [finding("color-contrast", "1.4.3", ".label")], { pages: [products] });
  const currentWithoutPage = report("current", site, newer, [], { pages: [site] });
  assert.equal(compareReports(currentWithoutPage, previous).counts.fixed, 0);
  assert.equal(compareReports(currentWithoutPage, previous).excludedForCoverage, 1);

  const currentWithReview = report("current", site, newer, [], {
    pages: [products], incomplete: [finding("color-contrast", "1.4.3", ".label")]
  });
  assert.equal(compareReports(currentWithReview, previous).counts.fixed, 0);
  assert.equal(compareReports(currentWithReview, previous).excludedForReview, 1);
});

test("requires a distinct older completed report", () => {
  const current = report("current", site, newer);
  assert.throws(() => compareReports(current, current), /different completed scans/);
  assert.throws(() => compareReports(report("old", site, older), current), /older than the current report/);
});
