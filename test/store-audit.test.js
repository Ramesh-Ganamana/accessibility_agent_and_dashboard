import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendAuditReview, readReport } from "../src/report/store.js";

test("review sidecars retain original evidence and serialize concurrent append operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accessibility-audit-store-"));
  const directory = path.join(root, "fixture");
  await fs.mkdir(directory);
  const original = JSON.stringify({ id: "fixture", targetUrl: "https://example.test", issues: [], incomplete: [], pages: [], configuration: { audit: { profile: "financial", wcagVersion: "2.2" } } });
  const file = path.join(directory, "vpat_draft.json");
  await fs.writeFile(file, original);
  const input = { kind: "check", targetId: "financial-kyc", status: "pass", reviewer: "QA fixture", notes: "Approved sandbox flow verified", scope: "Fixture build only", evidence: ["test-case-123"] };
  try {
    const initial = await readReport(root, "fixture");
    assert.equal(initial.audit.criteria.length, 55);
    assert.equal(initial.audit.criteria.every((row) => row.status === "Not Evaluated"), true);
    await Promise.all([appendAuditReview(root, "fixture", input), appendAuditReview(root, "fixture", { ...input, status: "fail", notes: "Follow-up review found a barrier" })]);
    const updated = await readReport(root, "fixture");
    assert.equal(updated.auditReviews.length, 2);
    assert.equal(new Set(updated.auditReviews.map((entry) => entry.id)).size, 2);
    assert.equal(updated.audit.checks.find((entry) => entry.id === "financial-kyc").status, "fail");
    assert.equal(await fs.readFile(file, "utf8"), original);
    await assert.rejects(appendAuditReview(root, "fixture", { ...input, evidence: [] }), { status: 400 });
    await assert.rejects(readReport(root, "../fixture"), { status: 400 });
    assert.equal((await readReport(root, "fixture")).auditReviews.length, 2);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("accessibility-audit-store-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});
