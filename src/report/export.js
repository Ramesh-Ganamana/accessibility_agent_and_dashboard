import fs from "node:fs/promises";
import path from "node:path";
import { WCAG_REGISTRY } from "../scanner/wcag.js";
import { buildAudit } from "./audit.js";

export { buildAudit, validateAuditReview } from "./audit.js";

export async function writeReportFiles(report, outputDir) {
  report.audit = buildAudit(report);
  report.acr = report.audit.criteria;
  report.wcagRegistry = WCAG_REGISTRY;
  await fs.mkdir(outputDir, { recursive: true });
  await writeAtomic(path.join(outputDir, "vpat_draft.json"), JSON.stringify(report, null, 2));
  await writeSummary(report, outputDir);
  await fs.writeFile(path.join(outputDir, "ACR_VPAT_Report.csv"), renderAcrCsv(report), "utf8");
  await fs.writeFile(path.join(outputDir, "ACR_VPAT_Report.html"), renderAcrHtml(report), "utf8");
  return report;
}

// Saves an in-progress or failed scan so a crash or restart leaves a usable
// partial report. Exports are only produced for completed scans.
export async function writeReportCheckpoint(report, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const snapshot = { ...report, summary: report.status === "complete" ? report.summary : { ...(report.summary || {}), pagesScanned: report.pages.length, confirmedIssues: report.issues.length, needsReview: report.incomplete.length } };
  await writeAtomic(path.join(outputDir, "vpat_draft.json"), JSON.stringify(snapshot));
  await writeSummary(snapshot, outputDir);
}

async function writeSummary(report, outputDir) {
  const summary = { id: report.id, targetUrl: report.targetUrl, startedAt: report.startedAt, completedAt: report.completedAt, status: report.status || (report.completedAt ? "complete" : "unknown"), summary: report.summary };
  await writeAtomic(path.join(outputDir, "summary.json"), JSON.stringify(summary));
}

async function writeAtomic(file, content) {
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.writeFile(temporary, content, "utf8");
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function renderAcrCsv(report) {
  const audit = buildAudit(report);
  const headers = ["Record Type", "Identifier", "Criterion / Check", "Level", "Status", "Confirmed Findings", "Needs-review Findings", "Remarks / Instructions", "Reviewer", "Review Scope", "Evidence References", "Reviewed At"];
  const metadata = [
    ["Notice", audit.notice], ["Application URL", audit.scope.targetUrl], ["Report ID", audit.scope.reportId],
    ["Profile", audit.profile], ["WCAG version", audit.wcagVersion], ["Target level", audit.level],
    ["Application version", audit.scope.applicationVersion], ["Scan started", audit.scope.startedAt], ["Scan completed", audit.scope.completedAt],
    ["Coverage limits", audit.scope.limitations.join("\n")], ["Methods", audit.methods.explanation],
    ["NVDA execution", `${audit.methods.nvdaStatus}${audit.methods.nvdaOutcome ? ` / ${audit.methods.nvdaOutcome}` : ""}`],
    ["Best-practice findings (not WCAG, not scored)", String((report.bestPractices || []).length)],
    ...(audit.regulatoryNotice ? [["Regulatory notice", audit.regulatoryNotice]] : [])
  ].map(([name, value]) => ["Metadata", "", name, "", "", "", "", value, "", "", "", ""]);
  const criteria = audit.criteria.map((row) => ["WCAG criterion", row.id, row.criterion, row.level, row.status, row.issueCount, row.needsReviewCount, row.remarks, row.review?.reviewer, row.review?.scope, reviewEvidence(row).join("\n"), row.review?.at]);
  const checks = audit.checks.map((row) => ["Manual check", row.id, row.title, "", row.status, "", "", `${row.instructions}${row.review ? ` Reviewer notes: ${row.review.notes}` : ""}`, row.review?.reviewer, row.review?.scope, (row.review?.evidence || []).join("\n"), row.review?.at]);
  const financial = audit.financial;
  const financialMetadata = financial ? [
    ["Financial assessment notice", financial.notice], ["Financial safety", financial.safetyNotice],
    ["Financial recorded review progress", `${financial.summary.stepsReviewed}/${financial.summary.stepsTotal} steps; ${financial.summary.passed} recorded pass; ${financial.summary.failed} failed; ${financial.summary.blocked} blocked; ${financial.summary.notApplicable} not applicable; ${financial.summary.pending} pending`],
    ["Financial review limitations", financial.completionNotice], ["Financial review gaps", financial.readiness.blockers.join("\n")],
    ["Professional BFSI experience", financial.professionalExperience]
  ].map(([name, value]) => ["Metadata", "", name, "", "", "", "", value, "", "", "", ""]) : [];
  const financialRows = financial?.journeys.flatMap((journey) => journey.steps.map((row) => [
    "Financial scenario step", row.id, `${journey.title}: ${row.title}`, row.criteria.join("; "), row.status, "", "",
    [`Objective: ${journey.objective}`, `Prerequisites: ${journey.prerequisites.join(" ")}`, `Procedure: ${row.instructions}`, `Expected: ${row.expected}`, `Evidence guidance: ${row.evidenceGuidance}`, `Sandbox required for execution: ${row.requiresSandbox ? "yes" : "no"}`, row.review ? `Observed result: ${row.review.notes}` : "Not tested / no valid recorded review", ...financialExecutionLines(row.review)].join("\n"),
    row.review?.reviewer, row.review?.scope, (row.review?.evidence || []).join("\n"), row.review?.at
  ])) || [];
  return [headers, ...metadata, ...criteria, ...checks, ...financialMetadata, ...financialRows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function renderAcrHtml(report) {
  const audit = buildAudit(report);
  const escaped = escapeHtml;
  const details = [
    ["Application", audit.scope.targetUrl], ["Report", audit.scope.reportId],
    ["Profile", audit.profile === "financial" ? "Financial web application" : "General web application"],
    ["Target standard", `WCAG ${audit.wcagVersion} ${audit.level} (includes level A)`],
    ["Application version", audit.scope.applicationVersion], ["Scan started", audit.scope.startedAt || "Not recorded"],
    ["Scan completed", audit.scope.completedAt || "Not recorded"],
    ["Review coverage", `${audit.summary.criteriaReviewed} / ${audit.summary.criteriaTotal} criteria; ${audit.summary.checksReviewed} / ${audit.summary.checksTotal} manual checks`],
    ["Observed coverage", `${audit.scope.pages.length} page records; ${audit.scope.statesRecorded} state records`],
    ["NVDA execution", `${audit.methods.nvdaStatus}${audit.methods.nvdaOutcome ? ` / ${audit.methods.nvdaOutcome}` : ""}`],
    ["Best-practice findings", `${(report.bestPractices || []).length} (axe best practices with no WCAG criterion; not counted as conformance failures)`]
  ];
  const criterionRows = audit.criteria.map((row) => `<tr><th scope="row"><a href="${escaped(row.sourceUrl)}">${escaped(row.criterion)}</a><small>Level ${escaped(row.level)}</small></th><td>${escaped(row.status)}</td><td>${row.issueCount} confirmed<br>${row.needsReviewCount} need review</td><td>${escaped(row.remarks)}${reviewDetails(row.review)}${textList(reviewEvidence(row), "Evidence references")}</td></tr>`).join("");
  const manualRows = audit.checks.map((row) => `<tr><th scope="row">${escaped(row.title)}<small>${escaped(row.category)}${row.criteria.length ? ` · ${escaped(row.criteria.join(", "))}` : ""}</small></th><td>${escaped(row.status)}</td><td>${escaped(row.instructions)}${reviewDetails(row.review)}${textList(row.review?.evidence || [], "Evidence references")}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accessibility audit — working draft</title>
<style>body{font-family:system-ui,sans-serif;color:#192b25;background:#fff;margin:0;line-height:1.5}main{max-width:1320px;margin:auto;padding:32px}h1{font-size:2rem;line-height:1.2}h2{margin-top:36px}.notice{background:#fff6d9;border-left:5px solid #846000;padding:16px}.metadata{display:grid;grid-template-columns:minmax(150px,1fr) 3fr;gap:8px 20px}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border:1px solid #bdcbc5;padding:12px;text-align:left;vertical-align:top;overflow-wrap:anywhere}thead th{background:#edf4f0}tbody th{width:25%}small{display:block;font-weight:400;color:#43574f}a{color:#075f50}ul{padding-left:22px}.review{margin-top:12px}li{overflow-wrap:anywhere}.table-scroll{overflow-x:auto}@media(max-width:650px){main{padding:16px}.metadata{grid-template-columns:1fr}dd{margin-bottom:8px}table{min-width:760px}}@media print{main{padding:0}thead{display:table-header-group}tr{break-inside:avoid}a{color:inherit}.table-scroll{overflow:visible}table{font-size:8pt}h2{break-after:avoid}}</style></head>
<body><main><header><p>ACCESSIBILITY AUDIT WORKSPACE</p><h1>${escaped(audit.title)}</h1><p class="notice">${escaped(audit.notice)}</p>${audit.regulatoryNotice ? `<p class="notice">${escaped(audit.regulatoryNotice)}</p>` : ""}</header>
<h2>Scope and methods</h2><dl class="metadata">${details.map(([label, value]) => `<dt>${escaped(label)}</dt><dd>${escaped(value)}</dd>`).join("")}</dl><p>${escaped(audit.methods.explanation)}</p>
${textList(audit.scope.limitations, "Coverage limitations")}
<h2>WCAG criterion decisions</h2><p>Not Evaluated means a documented criterion decision is still required. It does not mean pass or fail. Automated severity is used for triage, not conformance.</p><div class="table-scroll"><table><thead><tr><th scope="col">Criterion</th><th scope="col">Reviewer decision</th><th scope="col">Automated findings</th><th scope="col">Remarks and evidence</th></tr></thead><tbody>${criterionRows}</tbody></table></div>
<h2>Manual review checklist</h2><p>Checklist completion does not automatically set a WCAG conformance decision. Each criterion needs its own scoped review.</p><div class="table-scroll"><table><thead><tr><th scope="col">Check</th><th scope="col">Review status</th><th scope="col">Instructions and evidence</th></tr></thead><tbody>${manualRows}</tbody></table></div>
${renderFinancialHtml(audit.financial)}
<h2>References</h2><ul>${audit.references.map((reference) => `<li><a href="${escaped(reference.url)}">${escaped(reference.title)}</a></li>`).join("")}</ul><p>Reference list reviewed ${escaped(audit.referencesReviewedOn)}. Verify current regulatory applicability before issuing a final report.</p></main></body></html>`;
}

function financialExecutionLines(review) {
  if (!review?.execution) return [];
  const execution = review.execution;
  return [
    `Environment: ${execution.environment}`, `Application build: ${execution.applicationVersion}`,
    `Browser / OS: ${execution.browser}`, `Assistive technology / test method: ${execution.assistiveTechnology}`,
    `Authorization reference: ${execution.authorizationRef}`,
    `Linked finding IDs: ${(review.findingIds || []).join(", ") || "None recorded"}`
  ];
}

function renderFinancialHtml(financial) {
  if (!financial) return "";
  const s = financial.summary;
  return `<section><h2>BFSI / Capital Markets guided assessment</h2><p class="notice">${escapeHtml(financial.notice)}</p><p>${escapeHtml(financial.safetyNotice)}</p>
<p><strong>Recorded manual review:</strong> ${s.stepsReviewed} / ${s.stepsTotal} steps across ${s.journeysTotal} journeys. ${s.passed} recorded pass; ${s.failed} failed; ${s.blocked} blocked; ${s.notApplicable} not applicable; ${s.pending} pending.</p>
<p>${escapeHtml(financial.completionNotice)}</p>${textList(financial.readiness.blockers, "Outstanding scenario review gaps")}
<p><strong>Professional BFSI experience:</strong> not established by this tool.</p>
${financial.journeys.map((journey) => `<h3>${escapeHtml(journey.title)}</h3><p>${escapeHtml(journey.objective)}</p>${textList(journey.prerequisites, "Prerequisites")}<div class="table-scroll"><table><thead><tr><th>Test step / criteria</th><th>Procedure and expected outcome</th><th>Recorded result / evidence</th></tr></thead><tbody>${journey.steps.map((step) => `<tr><th scope="row">${escapeHtml(step.title)}<small>${escapeHtml(step.id)} · WCAG ${escapeHtml(step.criteria.join(", "))}</small>${step.requiresSandbox ? "<small>Sandbox/staging required for execution</small>" : ""}</th><td>${escapeHtml(step.instructions)}<p><strong>Expected:</strong> ${escapeHtml(step.expected)}</p><small>${escapeHtml(step.evidenceGuidance)}</small></td><td><strong>${escapeHtml(step.status)}</strong>${reviewDetails(step.review)}${textList(financialExecutionLines(step.review), "Execution context")}${textList(step.review?.evidence || [], "Evidence references")}</td></tr>`).join("")}</tbody></table></div>`).join("")}</section>`;
}

function csvCell(value) {
  const raw = String(value ?? "");
  // Imported site text and reviewer notes must not become spreadsheet formulas.
  const string = /^[\s\u0000-\u001f]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function reviewEvidence(row) {
  return [...new Set([...(row.review?.evidence || []), ...(row.evidence || []).map((entry) => [entry.pageUrl, entry.state, entry.target, entry.screenshot].filter(Boolean).join(" · "))])];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function textList(values, title) {
  return values.length ? `<p><strong>${escapeHtml(title)}</strong></p><ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : "";
}

function reviewDetails(review) {
  return review ? `<p class="review"><strong>Reviewer:</strong> ${escapeHtml(review.reviewer)}<br><strong>Scope:</strong> ${escapeHtml(review.scope)}<br><strong>Notes:</strong> ${escapeHtml(review.notes)}<br><strong>Recorded:</strong> ${escapeHtml(review.at || "Not recorded")}</p>` : "";
}

