import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";
import { checkPdf } from "../src/scanner/documents.js";

// Synthetic PDFs generated locally by Chromium; no external documents.
const browser = await chromium.launch({ headless: true });
const make = async (html, options) => {
  const page = await browser.newPage();
  await page.setContent(html);
  const pdf = await page.pdf(options);
  await page.close();
  return pdf;
};
const goodPdf = await make('<html lang="en"><head><title>Annual statement</title></head><body><h1>Statement</h1><p>Balance details.</p><img alt="Growth chart" src="data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2240%22/>"></body></html>', { tagged: true, outline: true });
const plainPdf = await make("<html><body><h1>Contract note</h1><p>Trade confirmation text.</p></body></html>", { tagged: false });
const scannedPdf = await make('<html><body><img style="width:400px;height:300px" src="data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22300%22><rect width=%22400%22 height=%22300%22 fill=%22%23ddd%22/></svg>"></body></html>', { tagged: false });
await browser.close();

const good = await checkPdf(goodPdf);
assert.deepEqual(good.issues.map((issue) => issue.ruleId), [], `a tagged PDF with title, language and alt text passes (${good.issues.map((issue) => issue.ruleId)})`);
assert.equal(good.summary.tagged, true);
const plain = await checkPdf(plainPdf);
for (const rule of ["pdf-untagged", "pdf-no-title", "pdf-no-language"]) assert.ok(plain.issues.some((issue) => issue.ruleId === rule), `${rule} is reported for an untagged PDF`);
assert.ok((await checkPdf(scannedPdf)).issues.some((issue) => issue.ruleId === "pdf-image-only"), "an image-only PDF is reported");

const server = http.createServer((request, response) => {
  const files = { "/docs/good.pdf": goodPdf, "/docs/plain.pdf": plainPdf };
  const pathname = new URL(request.url, "http://fixture.local").pathname;
  if (files[pathname]) { response.setHeader("content-type", "application/pdf"); response.end(files[pathname]); return; }
  if (pathname === "/docs/terms.docx") { response.setHeader("content-type", "application/octet-stream"); response.end("PK"); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="en"><head><title>Documents</title></head><body><main><h1>Investor documents</h1>
    <p><a href="/docs/good.pdf">Annual statement (PDF)</a></p><p><a href="/docs/plain.pdf?token=secret-signed-value">Contract note (PDF)</a></p>
    <p><a href="/docs/terms.docx">Terms (Word)</a></p><p><a href="https://other.example/brochure.pdf">Partner brochure</a></p></main></body></html>`);
});
const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "documents-"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const config = getConfig({ targetUrl: `http://127.0.0.1:${server.address().port}/`, maxPages: 1, maxDepth: 0, headless: true, browserChannel: "bundled", aiEnabled: false, login: false });
  config.reportsDir = reportsDir;
  config.authStatePath = path.join(reportsDir, "auth.json");
  config.legacyAuthStatePath = null;
  const report = await runAccessibilityScan(config);
  assert.equal(report.documents.discovered.length, 3, "same-site documents are discovered; the external brochure is not");
  assert.equal(report.documents.checked.length, 2, `both same-site PDFs are downloaded and checked (${JSON.stringify(report.documents.skipped)})`);
  assert.ok(report.documents.skipped.some((entry) => entry.type === "word"), "the Word file is listed for manual review");
  const pdfFindings = report.incomplete.filter((finding) => finding.source === "pdf-check");
  assert.ok(pdfFindings.some((finding) => finding.ruleId === "pdf-untagged" && finding.documentUrl.includes("plain.pdf")));
  assert.equal(pdfFindings.some((finding) => finding.documentUrl.includes("good.pdf")), false);
  const saved = await fs.readFile(path.join(reportsDir, report.id, "vpat_draft.json"), "utf8");
  assert.equal(saved.includes("secret-signed-value"), false, "signed document query values are never written to the report");
  console.log(`Document checks passed: ${report.documents.checked.length} PDFs checked, ${pdfFindings.length} PDF findings, ${report.documents.skipped.length} document(s) listed for manual review.`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (!process.env.KEEP_FIXTURE_REPORT) await fs.rm(reportsDir, { recursive: true, force: true }); else console.log("kept", reportsDir);
}
