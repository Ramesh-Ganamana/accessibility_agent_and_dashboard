import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { consolidateDuplicateVisualFindings, createEvidenceRegistry, storeDeduplicatedEvidence } from "../src/scanner/evidence.js";

test("identical screenshot bytes are stored once and reuse the first report path", async (t) => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-evidence-"));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const registry = createEvidenceRegistry();
  const buffer = Buffer.from("same screenshot bytes");
  const first = await storeDeduplicatedEvidence({ outputDir, fileName: "0001-rule.png", buffer, registry });
  const second = await storeDeduplicatedEvidence({ outputDir, fileName: "0002-rule.png", buffer, registry });
  assert.equal(first.path, "evidence/0001-rule.png");
  assert.equal(first.duplicate, false);
  assert.equal(second.path, first.path);
  assert.equal(second.duplicate, true);
  const files = await fs.readdir(path.join(outputDir, "evidence"));
  assert.deepEqual(files, ["0001-rule.png"]);
});

test("different screenshot bytes retain separate report paths", async (t) => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-evidence-"));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const registry = createEvidenceRegistry();
  const first = await storeDeduplicatedEvidence({ outputDir, fileName: "0001.png", buffer: Buffer.from("one"), registry });
  const second = await storeDeduplicatedEvidence({ outputDir, fileName: "0002.png", buffer: Buffer.from("two"), registry });
  assert.notEqual(second.path, first.path);
  assert.equal(second.duplicate, false);
});

test("exact duplicate highlighted findings are merged without losing their selectors or states", () => {
  const report = {
    issues: [
      { id: "one", ruleId: "color-contrast", pageUrl: "https://example.test", state: "default", target: [".label"], evidence: "evidence/0001.png", evidenceKind: "highlighted" },
      { id: "two", ruleId: "color-contrast", pageUrl: "https://example.test", state: "interaction:menu", target: ["span.label"], evidence: "evidence/0001.png", evidenceKind: "highlighted" }
    ],
    incomplete: [],
    pages: [{ issueIds: ["one", "two"], incompleteIds: [] }]
  };

  assert.equal(consolidateDuplicateVisualFindings(report), 1);
  assert.equal(report.issues.length, 1);
  assert.deepEqual(report.issues[0].observedOccurrences, [
    { id: "one", state: "default", target: [".label"] },
    { id: "two", state: "interaction:menu", target: ["span.label"] }
  ]);
  assert.deepEqual(report.pages[0].issueIds, ["one"]);
});

test("shared page-context screenshots do not merge distinct review findings", () => {
  const report = {
    issues: [],
    incomplete: [
      { id: "one", ruleId: "label", pageUrl: "https://example.test", contextEvidence: "evidence/baselines/page.png", evidenceKind: "page-context" },
      { id: "two", ruleId: "contrast", pageUrl: "https://example.test", contextEvidence: "evidence/baselines/page.png", evidenceKind: "page-context" }
    ],
    pages: [{ issueIds: [], incompleteIds: ["one", "two"] }]
  };

  assert.equal(consolidateDuplicateVisualFindings(report), 0);
  assert.equal(report.incomplete.length, 2);
});
