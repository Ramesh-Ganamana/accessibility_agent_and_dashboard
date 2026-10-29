import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { sanitizeUrl } from "../url-security.js";
import { isExcludedActionUrl, prepareActionExclusions } from "../browser/action-exclusions.js";

// Statements, contract notes and disclosures are often PDFs linked from the
// site. Same-site PDFs are downloaded through the scan's browser session and
// checked with pdf.js; other document formats are listed for manual review.
const DOCUMENT_TYPES = [
  [/\.pdf$/i, "pdf"], [/\.docx?$/i, "word"], [/\.xlsx?$/i, "spreadsheet"], [/\.pptx?$/i, "presentation"], [/\.(?:odt|ods|odp|rtf|epub)$/i, "other"]
];
let pdfjsPromise;

async function loadPdfjs() {
  pdfjsPromise ||= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    const require = createRequire(import.meta.url);
    // Node needs a file:// URL for the worker on Windows.
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
    return pdfjs;
  });
  return pdfjsPromise;
}

export function documentType(url) {
  try {
    const { pathname } = new URL(url);
    return DOCUMENT_TYPES.find(([pattern]) => pattern.test(pathname))?.[1] || null;
  } catch {
    return null;
  }
}

// Collects same-site document links on the current page into report.documents.
export async function collectDocumentLinks(page, report, isSameSite, downloadUrls = new Map(), options = {}) {
  // A link on the Do not click list is never downloaded: re-prime the page
  // policy first, and check the address itself as well.
  await prepareActionExclusions(page, options);
  const links = (await page.evaluate(() => [...document.querySelectorAll("a[href]")]
    .filter((anchor) => !window.__clarityActionExclusions?.matches(anchor))
    .map((anchor) => ({ href: anchor.href, label: (anchor.getAttribute("aria-label") || anchor.textContent || anchor.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 120) })))
    .catch(() => [])).filter((link) => !isExcludedActionUrl(link.href, options.excludeLabels));
  report.documents ||= { discovered: [], checked: [], skipped: [] };
  const known = new Set(report.documents.discovered.map((entry) => entry.url));
  for (const link of links) {
    const type = documentType(link.href);
    const url = sanitizeUrl(link.href);
    if (!type || !url || known.has(url) || !isSameSite(link.href) || report.documents.discovered.length >= 200) continue;
    known.add(url);
    // The original href (which may carry a signed query) stays in memory for the
    // download; only the sanitized URL is written to the report and checkpoints.
    downloadUrls.set(url, link.href);
    report.documents.discovered.push({ url, label: link.label, type, foundOn: sanitizeUrl(page.url()) || page.url() });
  }
}

// Downloads and checks up to maxDocuments same-site PDFs. Returns needs-review findings.
export async function scanDocuments(context, report, { maxDocuments = 10, maxBytes = 25 * 1024 * 1024, emit = () => {}, downloadUrls = new Map(), excludeLabels = [] } = {}) {
  const documents = report.documents;
  if (!documents?.discovered.length) return [];
  const findings = [];
  const pdfs = documents.discovered.filter((entry) => entry.type === "pdf");
  for (const entry of documents.discovered.filter((item) => item.type !== "pdf")) {
    documents.skipped.push({ url: entry.url, type: entry.type, reason: "Only PDF internals are checked automatically. Review this document with a format-specific tool and a screen reader." });
  }
  for (const [index, entry] of pdfs.entries()) {
    if (index >= maxDocuments) {
      documents.skipped.push({ url: entry.url, type: "pdf", reason: `Not checked: the ${maxDocuments}-document limit (DOCUMENTS_MAX) was reached.` });
      continue;
    }
    if (isExcludedActionUrl(downloadUrls.get(entry.url) || entry.url, excludeLabels)) {
      documents.skipped.push({ url: entry.url, type: "pdf", reason: "Not downloaded: the link is on the application's Do not click list." });
      continue;
    }
    emit({ type: "documents", message: `Checking PDF ${index + 1} of ${Math.min(pdfs.length, maxDocuments)}: ${entry.label || entry.url}`, url: entry.url });
    try {
      const response = await context.request.get(downloadUrls.get(entry.url) || entry.url, { timeout: 30_000, maxRedirects: 5 });
      const declared = Number(response.headers()["content-length"] || 0);
      if (!response.ok()) throw new Error(`the server returned HTTP ${response.status()}`);
      if (declared > maxBytes) throw new Error(`the file is larger than ${Math.round(maxBytes / 1048576)} MB`);
      const buffer = await response.body();
      if (buffer.length > maxBytes) throw new Error(`the file is larger than ${Math.round(maxBytes / 1048576)} MB`);
      if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("the link did not return a PDF (it may require a login or redirect to a page)");
      const result = await checkPdf(buffer);
      documents.checked.push({ url: entry.url, label: entry.label, foundOn: entry.foundOn, bytes: buffer.length, ...result.summary });
      for (const issue of result.issues) findings.push(documentFinding(issue, entry));
    } catch (error) {
      documents.skipped.push({ url: entry.url, type: "pdf", reason: `Could not be checked: ${String(error.message || error).split("\n", 1)[0]}` });
    }
  }
  return findings;
}

// Checks one PDF. Exported for unit tests.
export async function checkPdf(buffer, { maxPagesForStructure = 20 } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const { info } = await pdf.getMetadata().catch(() => ({ info: {} }));
    const outline = await pdf.getOutline().catch(() => null);
    const pages = pdf.numPages;
    let tagged = false;
    let figures = 0;
    let figuresWithoutAlt = 0;
    let textPagesChecked = 0;
    let pagesWithText = 0;
    let unnamedFields = 0;
    let fields = 0;
    for (let number = 1; number <= Math.min(pages, maxPagesForStructure); number += 1) {
      const page = await pdf.getPage(number);
      const tree = await page.getStructTree().catch(() => null);
      if (tree?.children?.length) tagged = true;
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (node.role === "Figure") {
          figures += 1;
          if (!String(node.alt || "").trim()) figuresWithoutAlt += 1;
        }
        (node.children || []).forEach(walk);
      };
      walk(tree);
      if (number <= 3) {
        textPagesChecked += 1;
        const text = await page.getTextContent().catch(() => ({ items: [] }));
        if (text.items.some((item) => String(item.str || "").trim())) pagesWithText += 1;
      }
      for (const annotation of await page.getAnnotations().catch(() => [])) {
        if (annotation.subtype !== "Widget" || annotation.hidden) continue;
        fields += 1;
        if (!String(annotation.alternativeText || "").trim()) unnamedFields += 1;
      }
      page.cleanup();
    }
    const title = String(info?.Title || "").trim();
    const language = String(info?.Language || "").trim();
    const issues = [];
    if (!tagged) issues.push({ ruleId: "pdf-untagged", wcag: ["1.3.1"], impact: "serious", help: "PDF is not tagged", description: "No tag structure was found, so screen readers cannot convey headings, lists, tables or reading order." });
    if (!title) issues.push({ ruleId: "pdf-no-title", wcag: ["2.4.2"], impact: "moderate", help: "PDF has no document title", description: "The document properties contain no Title, so assistive technology announces the file name instead." });
    if (!language) issues.push({ ruleId: "pdf-no-language", wcag: ["3.1.1"], impact: "moderate", help: "PDF does not declare its language", description: "No document language is set, so screen readers may read the text with the wrong pronunciation." });
    if (textPagesChecked && !pagesWithText) issues.push({ ruleId: "pdf-image-only", wcag: ["1.1.1", "1.4.5"], impact: "critical", help: "PDF appears to be scanned images without text", description: `None of the first ${textPagesChecked} page(s) contain extractable text. The content is likely an image and unavailable to screen readers.` });
    if (figuresWithoutAlt) issues.push({ ruleId: "pdf-figure-no-alt", wcag: ["1.1.1"], impact: "serious", help: "PDF figures have no alternative text", description: `${figuresWithoutAlt} of ${figures} tagged figure(s) in the checked pages have no alternative text.` });
    if (pages > 20 && !(outline?.length)) issues.push({ ruleId: "pdf-no-bookmarks", wcag: ["2.4.5"], impact: "minor", help: "Long PDF has no bookmarks", description: `The document has ${pages} pages but no bookmarks for navigating between sections.` });
    if (unnamedFields) issues.push({ ruleId: "pdf-form-field-no-name", wcag: ["4.1.2", "3.3.2"], impact: "serious", help: "PDF form fields have no accessible name", description: `${unnamedFields} of ${fields} form field(s) have no tooltip (TU) text, which is what screen readers announce as the field name.` });
    return {
      summary: { pages, tagged, title: title || null, language: language || null, figures, figuresWithoutAlt, formFields: fields, unnamedFormFields: unnamedFields, bookmarks: outline?.length || 0, textDetected: pagesWithText > 0, issues: issues.map((issue) => issue.ruleId) },
      issues
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

function documentFinding(issue, entry) {
  return {
    id: `${issue.ruleId}-${simpleHash(entry.url)}`,
    findingType: "needs-review",
    ruleId: issue.ruleId,
    impact: issue.impact,
    help: issue.help,
    description: `${issue.description} Document: ${entry.label || entry.url}.`,
    helpUrl: "https://www.w3.org/WAI/WCAG22/Techniques/#pdf",
    tags: issue.wcag.map((id) => `wcag${id.replaceAll(".", "")}`),
    wcag: issue.wcag,
    target: [entry.url],
    html: `<a href="${entry.url}">${escapeHtml(entry.label || "document")}</a>`,
    failureSummary: issue.description,
    pageUrl: entry.foundOn,
    frameUrl: entry.foundOn,
    documentUrl: entry.url,
    state: "document",
    evidence: null,
    source: "pdf-check"
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function simpleHash(value) {
  let hash = 0;
  for (const char of value) hash = Math.imul(31, hash) + char.charCodeAt(0) | 0;
  return Math.abs(hash).toString(36);
}
