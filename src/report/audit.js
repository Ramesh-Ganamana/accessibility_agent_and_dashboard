import { randomUUID } from "node:crypto";
import { buildAcrRows, CONFORMANCE_STATUSES, criteriaFromTags, isDocumentedReview } from "../scanner/wcag.js";
import { buildFinancialAssessment, financialStepById, FINANCIAL_STATUSES, validateFinancialExecution } from "./financial.js";
import { findVpatRow, SECTION_508, EN_301_549 } from "./vpat.js";
import { COMPLIANCE_STATUSES } from "./compliance.js";

const check = (id, title, criteria, instructions, category = "Manual web review") => ({ id, title, criteria, instructions, category });
export const GENERAL_CHECKS = [
  check("scope-and-processes", "Representative pages and complete processes", [], "Record the application version, roles, browsers, devices, sampled pages and excluded areas. Exercise each agreed process from start to completion in a test environment; record every untested step."),
  check("keyboard-workflows", "Keyboard operation, focus order and traps", ["2.1.1", "2.1.2", "2.1.4", "2.4.1", "2.4.3", "2.4.7", "2.4.11"], "Complete agreed journeys with keyboard only, including opening and leaving menus and dialogs. Inspect meaningful order, skip links, focus visibility and obstruction, shortcuts, and focus restoration."),
  check("screen-reader-workflows", "Screen-reader reading and operation", ["1.1.1", "1.3.1", "1.3.2", "2.4.6", "4.1.2", "4.1.3"], "Record reader, browser and OS versions. Check continuous reading, headings, landmarks, tables, control names/states, dynamic announcements and complete journeys. Attach speech and observed outcomes; a captured announcement alone is not a pass."),
  check("zoom-reflow-spacing", "Zoom, reflow and text spacing", ["1.3.4", "1.4.4", "1.4.10", "1.4.12"], "Inspect text at 200%, reflow at the equivalent of 320 CSS pixels, increased text spacing, and both orientations. Record clipping, overlapping, hidden controls and permitted exceptions."),
  check("visual-information", "Visual meaning, color and contrast", ["1.1.1", "1.3.3", "1.4.1", "1.4.3", "1.4.5", "1.4.11"], "Review meaningful image alternatives, instructions, graphs, text and controls in all relevant states. Verify information does not rely on color, position or shape alone, and manually resolve contrast uncertainty."),
  check("media-motion", "Audio, video, captions and movement", ["1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5", "1.4.2", "2.2.2", "2.3.1"], "Inventory media and moving content. Review equivalent alternatives, accurate synchronized captions, audio descriptions, audio controls, pause/stop controls and flash thresholds using appropriate tools."),
  check("forms-errors", "Form instructions, errors and recovery", ["1.3.5", "3.3.1", "3.3.2", "3.3.3", "3.3.4", "3.3.7"], "Use approved test data to check labels, purpose, required fields, validation and error recovery. Confirm information is preserved, redundant entry is avoided, and consequential submissions can be reviewed/corrected. Record the completed test process."),
  check("authentication-timeouts", "Authentication and time limits", ["2.2.1", "3.3.8"], "Test agreed login, MFA, CAPTCHA, recovery and timeout flows with keyboard and a screen reader. Review accessible alternatives, password-manager/paste support, warning and extension of time limits. Record exceptions and untested steps."),
  check("pointer-and-touch", "Pointer, touch and alternative operation", ["2.5.1", "2.5.2", "2.5.3", "2.5.4", "2.5.7", "2.5.8"], "Review gesture alternatives, cancellation, visible/accessibility name consistency, motion alternatives, drag alternatives and target sizes. Verify exceptions on representative mobile and desktop viewports."),
  check("navigation-and-language", "Consistent navigation, help and language", ["2.4.2", "2.4.4", "2.4.5", "2.4.6", "3.1.1", "3.1.2", "3.2.1", "3.2.2", "3.2.3", "3.2.4", "3.2.6"], "Across sampled pages and languages, inspect titles, link purposes, navigation routes, headings, help placement, language changes and unexpected context changes."),
  check("hover-and-dynamic-content", "Hover/focus content and dynamic feedback", ["1.4.13", "4.1.2", "4.1.3"], "Check tooltip and popover dismissal, persistence and pointer access. Review loading, errors, success messages, live updates and dialog announcements without relying on sight."),
  check("documents-third-parties", "Documents and embedded services", [], "Inventory downloads and third-party widgets used in agreed journeys. Test relevant PDFs/documents with suitable document tools and screen readers. Record separate format requirements, ownership and excluded content; the web scan does not audit PDF internals."),
  check("user-validation", "Usability review with people with disabilities", [], "Record participant needs, assistive technologies, tasks, observed barriers and retest outcomes for agreed journeys. Keep participant personal information out of shared evidence."),
  check("remediation-retest", "Remediation verification", [], "Record issue owners, fixes and build versions. Retest affected controls and complete journeys, including regressions. A finding absent from a later crawl is not proof that it was fixed.")
];

export const FINANCIAL_CHECKS = [
  check("financial-applicability", "Regulatory applicability and reporting scope", [], "Have the responsible compliance reviewer identify the regulated entity, platforms, applicable SEBI circulars and amendments, reporting authority and current timelines. Record the clause-by-clause assessment and approval evidence.", "Financial application review"),
  check("financial-standards", "GIGW and IS 17802 assessment", [], "Attach the applicable GIGW and IS 17802 requirements matrix, assessment method, exceptions and supporting evidence. This checklist does not implement a complete GIGW or IS 17802 audit.", "Financial application review"),
  check("financial-kyc", "Accessible onboarding and KYC alternatives", ["2.1.1", "3.3.1", "3.3.2", "3.3.8"], "Using approved test identities, review registration, document uploads, e-KYC/video KYC, identity verification and alternatives for disability-related barriers. Record available assistance and successful/error paths.", "Financial journeys"),
  check("financial-payments", "Payments and transfers", ["2.1.1", "3.3.1", "3.3.3", "3.3.4", "4.1.3"], "In an approved sandbox, inspect payee selection, amount/currency, charges, review/correction, authorization, receipt, failure and retry. Verify speech, focus and duplicate-payment prevention. The crawler does not execute live transactions.", "Financial journeys"),
  check("financial-trading", "Trading, orders and market information", ["1.1.1", "1.3.1", "1.4.1", "2.1.1", "2.2.2", "3.3.4", "4.1.3"], "In an approved trading sandbox, test watchlists, charts/data tables, quote updates, order review/correction, validation, status, modification and cancellation. Record keyboard/speech usability and alternatives to visual-only market signals.", "Financial journeys"),
  check("financial-statements", "Statements, disclosures and financial documents", [], "Inventory statements, contract notes, disclosures and downloadable forms. Test tagged structure, reading order, tables, names and equivalent accessible formats with document-specific tools.", "Financial application review"),
  check("financial-grievance", "Accessible complaints and escalation", ["2.1.1", "3.3.1", "3.3.2", "4.1.3"], "Test finding and filing an accessibility complaint, receiving acknowledgement, tracking status and escalation. Confirm the applicable investor-charter and accessibility contact process with the compliance owner.", "Financial journeys"),
  check("financial-governance", "Ownership, audit qualifications and remediation governance", [], "Record accessibility ownership, applicable auditor qualifications, audit/retest schedule, training, remediation accountability and management review. Include usability evidence involving people with disabilities where required.", "Financial application review"),
  check("financial-media", "Financial guidance and accessible media alternatives", ["1.1.1", "1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5"], "Inventory investor education and KYC explanations. Have the compliance reviewer assess required captions, descriptive audio, Indian Sign Language and equivalent formats against applicable directions.", "Financial application review")
];

export const AUDIT_REFERENCES = [
  { title: "W3C WCAG 2.1", url: "https://www.w3.org/TR/WCAG21/" },
  { title: "W3C WCAG 2.2", url: "https://www.w3.org/TR/WCAG22/" },
  { title: "ITI VPAT and ACR guidance", url: "https://www.itic.org/policy/accessibility/vpat" }
];
const FINANCIAL_REFERENCES = [
  { title: "SEBI Digital Accessibility framework (31 July 2025)", url: "https://www.sebi.gov.in/sebi_data/attachdocs/aug-2025/1754651443956.pdf" },
  { title: "SEBI Digital Accessibility clarification (8 December 2025)", url: "https://www.sebi.gov.in/legal/circulars/dec-2025/clarification-on-the-digital-accessibility-circulars-of-sebi_98238.html" },
  { title: "SEBI timeline extension (31 July 2026)", url: "https://www.sebi.gov.in/legal/circulars/jul-2026/extension-of-timelines-with-repect-to-compliance-of-digital-accessibility-circulars-_103277.html" },
  { title: "SEBI Digital KYC accessibility (23 May 2025)", url: "https://www.sebi.gov.in/legal/circulars/may-2025/accessibility-and-inclusiveness-of-digital-kyc-to-persons-with-disabilities_94096.html" }
];

export function normalizeAuditConfiguration(value = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Audit settings must be an object.");
  const profile = value?.profile ?? "general";
  const wcagVersion = value?.wcagVersion ?? "2.2";
  const level = value?.level ?? "AA";
  if (!["general", "financial"].includes(profile)) throw new Error("Audit profile must be general or financial.");
  if (!["2.1", "2.2"].includes(wcagVersion)) throw new Error("WCAG version must be 2.1 or 2.2.");
  if (level !== "AA") throw new Error("The audit workspace supports WCAG level AA (including A).");
  return { profile, wcagVersion, level };
}

export function buildAudit(report = {}) {
  const config = normalizeAuditConfiguration(report.configuration?.audit);
  const reviews = Array.isArray(report.auditReviews) ? report.auditReviews.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const incomplete = Array.isArray(report.incomplete) ? report.incomplete : [];
  const criteria = buildAcrRows(issues, incomplete, { ...config, reviews });
  const activeIds = new Set(criteria.map((row) => row.id));
  const checks = [...GENERAL_CHECKS, ...(config.profile === "financial" ? FINANCIAL_CHECKS : [])].map((entry) => {
    const candidate = [...reviews].reverse().find((review) => review.kind === "check" && review.targetId === entry.id);
    const review = documentedCheck(candidate) ? candidate : null;
    return { ...entry, criteria: entry.criteria.filter((id) => activeIds.has(id)), status: review?.status || "not-reviewed", review };
  });
  const outcomes = (report.pages || []).flatMap((page) => (page.ruleOutcomes || []).flatMap((frame) => frame.rules || []));
  for (const criterion of criteria) {
    const matched = outcomes.filter((rule) => (rule.wcag || criteriaFromTags(rule.tags)).includes(criterion.id));
    criterion.automation = Object.fromEntries(["pass", "fail", "needs-review", "inapplicable"].map((status) => [status, matched.filter((rule) => rule.status === status).length]));
    criterion.automation.observations = matched.length;
  }
  const nvda = report.assistiveTechnology?.actualRuns?.NVDA;
  const summary = {
    criteriaTotal: criteria.length, criteriaReviewed: criteria.filter((row) => row.review).length,
    criteriaPending: criteria.filter((row) => !row.review).length,
    checksTotal: checks.length, checksReviewed: checks.filter((row) => row.review).length,
    checksPending: checks.filter((row) => !row.review).length,
    confirmedFindings: issues.length, needsReviewFindings: incomplete.length
  };
  return {
    ...config, schemaVersion: 1, title: "Accessibility Conformance Report — working draft",
    notice: "Working audit material for review. This is not an official ITI VPAT template, a certification, or a regulatory compliance decision. Automated rule results and internal scores do not establish WCAG conformance.",
    scope: {
      reportId: report.id || "", targetUrl: report.targetUrl || "", startedAt: report.startedAt || null, completedAt: report.completedAt || null,
      applicationVersion: report.configuration?.applicationVersion || "Not recorded",
      pages: (report.pages || []).map((page) => ({ url: page.url || page.pageUrl || "", status: page.error ? "failed" : page.crawlStatus || page.status || "unknown", terminationReason: page.terminationReason || null })),
      statesRecorded: report.graph?.nodes?.length || 0, crawlTermination: report.crawlTermination || null,
      limitations: [...(report.limitations || []), "Coverage is limited to the observed pages/states and documented reviewer scope; unvisited content remains untested."]
    },
    methods: {
      automatedEngines: [...new Set([...issues.concat(incomplete).map((issue) => issue.source), ...(report.pages || []).flatMap((page) => (page.ruleOutcomes || []).map((frame) => frame.engine))].filter(Boolean))],
      ruleObservations: outcomes.length,
      screenReaders: report.assistiveTechnology?.actualScreenReaders || {},
      nvdaStatus: nvda?.status || "not-run", nvdaOutcome: nvda?.outcome || null,
      manualDecisions: reviews.length,
      explanation: "Automated findings, per-rule observations where captured, optional recorded screen-reader execution, and explicitly documented manual review decisions. A rule pass is limited to that rule and observed state."
    },
    summary, criteria, checks, reviews, financial: buildFinancialAssessment(report, config),
    // Section 508 and EN 301 549 rows used by the VPAT 2.5 exports.
    vpatRows: [...SECTION_508.map((chapter) => ({ ...chapter, standard: "508" })), ...EN_301_549.map((chapter) => ({ ...chapter, standard: "en" }))].flatMap((chapter) => chapter.rows.map((entry) => {
      const latest = [...reviews].reverse().find((review) => review.kind === "vpat-row" && review.targetId === entry.id);
      const review = isDocumentedReview(latest) ? latest : null;
      return { id: entry.id, criterion: entry.criterion, chapter: chapter.chapter, standard: chapter.standard, note: entry.note, status: review?.status || "Not Evaluated", review };
    })),
    references: [...AUDIT_REFERENCES, ...(config.profile === "financial" ? FINANCIAL_REFERENCES : [])],
    referencesReviewedOn: "2026-10-10",
    regulatoryNotice: config.profile === "financial" ? "The financial checklist is an assessment aid. Confirm applicability, current circulars, standards, reporting requirements and reviewer qualifications with the responsible compliance team. It is not a complete SEBI/GIGW/IS 17802 assessment." : null
  };
}

export function validateAuditReview(report, input, options = {}) {
  try { return validatedReview(report, input, options); }
  catch (error) { error.status = 400; throw error; }
}

function validatedReview(report, input, { findComplianceItem } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A review object is required.");
  const kind = input.kind;
  if (!["criterion", "check", "financial-step", "vpat-row", "compliance-item"].includes(kind)) throw new Error("Review kind must be criterion, check, financial-step, vpat-row or compliance-item.");
  const audit = buildAudit(report);
  const targetId = requiredText(input.targetId, "Target", 200);
  // Section 508 / EN 301 549 rows of the VPAT exports take their own decisions.
  const target = kind === "financial-step"
    ? (audit.profile === "financial" ? financialStepById(targetId) : null)
    : kind === "vpat-row" ? findVpatRow(targetId)
      : kind === "compliance-item" ? findComplianceItem?.(targetId)
        : (kind === "criterion" ? audit.criteria : audit.checks).find((row) => row.id === targetId);
  if (!target) throw new Error("Review target does not belong to this report's audit profile and WCAG version.");
  const permitted = kind === "criterion" || kind === "vpat-row" ? CONFORMANCE_STATUSES
    : kind === "financial-step" ? FINANCIAL_STATUSES
      : kind === "compliance-item" ? COMPLIANCE_STATUSES : ["pass", "fail", "not-applicable"];
  if (!permitted.includes(input.status)) throw new Error("Invalid review status.");
  if (kind === "criterion" && target.issueCount > 0 && ["Supports", "Not Applicable"].includes(input.status)) {
    throw new Error("Confirmed findings remain for this criterion. Supports or Not Applicable would conflict with this scan's evidence; record a supported decision or run a retest after remediation.");
  }
  if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 30) throw new Error("Provide 1 to 30 evidence references.");
  return {
    id: randomUUID(), kind, targetId, status: input.status,
    reviewer: requiredText(input.reviewer, "Reviewer", 200),
    notes: requiredText(input.notes, "Review notes", 10000),
    scope: requiredText(input.scope, "Tested scope and environment", 4000),
    evidence: [...new Set(input.evidence.map((value) => requiredText(value, "Evidence reference", 2000)))],
    at: new Date().toISOString(),
    ...(kind === "financial-step" ? validateFinancialExecution(report, input, target) : {})
  };
}

function documentedCheck(review) {
  return review && ["pass", "fail", "not-applicable"].includes(review.status)
    && [review.reviewer, review.notes, review.scope].every((value) => typeof value === "string" && value.trim())
    && Array.isArray(review.evidence) && review.evidence.some((value) => typeof value === "string" && value.trim());
}

function requiredText(value, name, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`${name} must contain 1 to ${limit} characters of text.`);
  }
  return value.trim();
}
