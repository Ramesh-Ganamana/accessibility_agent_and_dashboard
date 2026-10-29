import { $, element, textElement, formatDate, fetchJson, productStatus } from "../shared/ui.js";
import { state } from "../state.js";

function renderVpat(report) {
  const audit = report.audit;
  $("#audit-review-form").hidden = true;
  setFinancialReviewFields(false);
  $("#audit-review-message").textContent = "";
  $("#audit-description").textContent = audit ? `${audit.profile === "financial" ? "Financial application" : "General web application"} · WCAG ${audit.wcagVersion} A + AA · ${audit.summary.criteriaTotal} criteria in the review matrix` : "Preview only. Open a saved report for its complete review matrix.";
  $("#audit-notice").textContent = [audit?.notice || "This is working audit material, not certification or an official ITI VPAT template. Automated results do not establish conformance.", audit?.regulatoryNotice].filter(Boolean).join(" ");
  const summary = $("#audit-summary"); summary.replaceChildren();
  if (audit) for (const [label, value] of [["Criteria reviewed", `${audit.summary.criteriaReviewed} / ${audit.summary.criteriaTotal}`], ["Criteria pending", audit.summary.criteriaPending], ["Human checks pending", audit.summary.checksPending], ["Confirmed findings", audit.summary.confirmedFindings]]) {
    const card = element("div"); card.append(textElement("strong", value), textElement("span", label)); summary.append(card);
  }
  const scope = $("#audit-scope"); scope.replaceChildren();
  if (audit) {
    scope.append(textElement("p", `${audit.scope.targetUrl} · Application version: ${audit.scope.applicationVersion} · ${audit.scope.statesRecorded} recorded states`), textElement("p", audit.methods.explanation));
    const limits = element("ul"); for (const note of audit.scope.limitations || []) limits.append(textElement("li", typeof note === "string" ? note : JSON.stringify(note))); scope.append(limits);
  } else scope.append(textElement("p", "No saved audit scope is available in this preview."));
  const body = $("#vpat-body"); body.replaceChildren();
  for (const row of audit?.criteria || report.acr || []) {
    const tr = element("tr");
    const conformance = audit ? row.status : "Not Evaluated";
    const statusClass = conformance.toLowerCase().replaceAll(" ", "-");
    const status = textElement("span", conformance, `status-chip ${statusClass}`);
    const statusCell = element("td"); statusCell.append(status);
    const counts = element("td"); counts.append(textElement("strong", `${row.issueCount || 0} confirmed · ${row.needsReviewCount || 0} uncertain`));
    if (row.automation?.observations) counts.append(textElement("small", `${row.automation.pass} rule-pass observations · ${row.automation.fail} rule-fail observations (not criterion decisions)`));
    const remarks = element("td"); remarks.append(textElement("p", audit ? row.remarks : "Open a saved report to review evidence before making a conformance decision."));
    if (audit && report.id !== "demo") { const button = textElement("button", "Record review", "audit-review-button"); button.type = "button"; button.dataset.reviewTarget = row.id; button.addEventListener("click", () => openAuditReview("criterion", row)); remarks.append(button); }
    tr.append(textElement("td", row.criterion), textElement("td", row.level), statusCell, counts, remarks);
    body.append(tr);
  }
  const checklist = $("#audit-checklist"); checklist.replaceChildren();
  for (const check of audit?.checks || []) {
    const card = element("article"); card.dataset.checkId = check.id;
    card.append(textElement("small", check.category), textElement("h5", check.title), textElement("span", productStatus(check.status), `status-chip ${check.status}`), textElement("p", check.instructions));
    if (check.criteria.length) card.append(textElement("small", `Related WCAG criteria: ${check.criteria.join(", ")}`));
    const button = textElement("button", "Record review", "audit-review-button"); button.type = "button"; button.addEventListener("click", () => openAuditReview("check", check)); card.append(button); checklist.append(card);
  }
  renderFinancialReview(report);
  void renderVpatExport(report);
  void renderCompliance(report);
  const history = $("#audit-history"); history.replaceChildren();
  for (const review of [...(audit?.reviews || [])].reverse()) {
    const row = element("li"); row.append(textElement("strong", `${review.targetId || "Unknown target"} · ${productStatus(review.status)} · ${review.reviewer || "Reviewer not recorded"}`), textElement("small", review.at && Number.isFinite(new Date(review.at).getTime()) ? formatDate(review.at) : "Date not recorded"), textElement("p", review.notes || "No review notes recorded."), textElement("p", `Scope: ${review.scope || "Not recorded"}`), textElement("p", `Evidence: ${Array.isArray(review.evidence) ? review.evidence.join("; ") : "Not recorded"}`));
    appendFinancialExecution(row, review);
    history.append(row);
  }
  if (!history.children.length) history.append(textElement("li", "No human review entries recorded."));
}

function updateVpatLinks(report) {
  const saved = report && report.id !== "demo";
  for (const format of ["html", "docx"]) {
    const link = $(`#vpat-download-${format}`);
    if (!saved) { link.href = "#"; link.setAttribute("aria-disabled", "true"); continue; }
    link.href = `/api/reports/${encodeURIComponent(report.id)}/vpat/${$("#vpat-edition").value}/${format}`;
    link.removeAttribute("aria-disabled");
    link.download = "";
  }
}

async function renderVpatExport(report) {
  const saved = report && report.id !== "demo" && report.audit;
  $("#vpat-export").hidden = !saved;
  if (!saved) return;
  updateVpatLinks(report);
  const rows = report.audit.vpatRows || [];
  $("#vpat-rows-pending").textContent = String(rows.filter((row) => !row.review).length);
  const body = $("#vpat-rows-body");
  body.replaceChildren();
  for (const row of rows) {
    const tr = element("tr");
    const decision = element("td");
    decision.append(textElement("span", row.status, `status-chip ${row.status.toLowerCase().replaceAll(" ", "-")}`));
    const remarks = element("td");
    remarks.append(textElement("p", row.review ? `${row.review.notes} (${row.review.reviewer})` : row.note || "A documented reviewer decision is required."));
    const button = textElement("button", "Record decision", "audit-review-button");
    button.type = "button";
    button.setAttribute("aria-label", `Record decision: ${row.criterion}`);
    button.addEventListener("click", () => openAuditReview("vpat-row", { id: row.id, criterion: row.criterion }));
    remarks.append(button);
    tr.append(textElement("td", row.criterion), textElement("td", row.standard === "508" ? "Section 508" : "EN 301 549"), decision, remarks);
    body.append(tr);
  }
  const requestId = (state.vpatProfileRequestId = (state.vpatProfileRequestId || 0) + 1);
  try {
    const profile = await fetchJson(`/api/reports/${encodeURIComponent(report.id)}/vpat-profile`);
    if (requestId !== state.vpatProfileRequestId) return;
    $("#vpat-product").value = profile.productName || "";
    $("#vpat-version").value = profile.productVersion || "";
    $("#vpat-date").value = profile.reportDate || new Date().toISOString().slice(0, 10);
    $("#vpat-contact").value = profile.contact || "";
    $("#vpat-description").value = profile.description || "";
    $("#vpat-methods").value = profile.evaluationMethods || "";
    $("#vpat-notes").value = profile.notes || "";
  } catch (error) {
    $("#vpat-export-message").textContent = `Product details could not be loaded: ${error.message}`;
  }
}

async function renderCompliance(report) {
  const saved = report && report.id !== "demo" && report.audit;
  $("#compliance-checklists").hidden = !saved;
  if (!saved) return;
  const requestId = (state.complianceRequestId = (state.complianceRequestId || 0) + 1);
  try {
    const compliance = await fetchJson(`/api/reports/${encodeURIComponent(report.id)}/compliance`);
    if (requestId !== state.complianceRequestId) return;
    state.compliance = compliance;
    $("#compliance-notice").textContent = compliance.notice || "";
    const select = $("#compliance-set");
    const previous = state.complianceSet || select.value;
    select.replaceChildren(...compliance.sets.map((set) => new Option(`${set.title} (${set.summary.reviewed} of ${set.summary.total} decided)`, set.id)));
    if (compliance.sets.some((set) => set.id === previous)) select.value = previous;
    const link = $("#compliance-export");
    link.href = `/api/reports/${encodeURIComponent(report.id)}/compliance/export.csv`;
    link.download = "";
    renderComplianceSet();
  } catch (error) {
    if (requestId === state.complianceRequestId) $("#compliance-summary").textContent = `Checklists could not be loaded: ${error.message}`;
  }
}

function renderComplianceSet() {
  const set = state.compliance?.sets.find((entry) => entry.id === $("#compliance-set").value);
  const body = $("#compliance-body");
  body.replaceChildren();
  if (!set) return;
  state.complianceSet = set.id;
  const { summary } = set;
  $("#compliance-summary").textContent = `${summary.reviewed} of ${summary.total} requirements have a documented decision: ${summary.met} met, ${summary.partiallyMet} partially met, ${summary.notMet} not met, ${summary.notApplicable} not applicable.`;
  for (const item of set.items) {
    const tr = element("tr");
    const requirement = element("td");
    requirement.append(textElement("strong", item.title), textElement("p", item.requirement));
    if (item.verification) requirement.append(textElement("small", `How to verify: ${item.verification}`));
    if (item.note) requirement.append(textElement("p", `Note: ${item.note}`, "form-note"));
    const source = element("p", "form-note");
    source.append(`Source: ${item.sourceTitle || item.source || set.title} `);
    if (/^https:\/\//.test(item.sourceUrl || "")) {
      const link = textElement("a", "(open source)");
      link.href = item.sourceUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
      source.append(link);
    }
    requirement.append(source);
    const wcag = element("td");
    if (!item.relatedWcag.length) wcag.append(textElement("span", "Process requirement; no single WCAG criterion", "form-note"));
    for (const entry of item.relatedWcag) wcag.append(textElement("p", `${entry.id}: ${entry.status}${entry.findings ? ` (${entry.findings} findings)` : ""}`));
    const decision = element("td");
    decision.append(textElement("span", item.status === "not-reviewed" ? "Not reviewed" : productStatus(item.status), `status-chip ${item.status}`));
    if (item.review) decision.append(textElement("p", `${item.review.notes} (${item.review.reviewer})`));
    const button = textElement("button", "Record decision", "audit-review-button");
    button.type = "button";
    button.setAttribute("aria-label", `Record decision: ${item.reference} ${item.title}`);
    button.addEventListener("click", () => openAuditReview("compliance-item", { id: item.targetId, criterion: `${set.title} ${item.reference}: ${item.title}` }));
    decision.append(button);
    tr.append(textElement("td", item.reference), requirement, wcag, decision);
    body.append(tr);
  }
}

async function importComplianceChecklist(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $("#compliance-import-message");
  const payload = { id: $("#compliance-import-id").value, title: $("#compliance-import-title").value, format: "csv", csv: $("#compliance-import-csv").value };
  try {
    const response = await fetch("/api/compliance/sets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The checklist could not be imported.");
    message.textContent = `Imported ${data.title} with ${data.items} requirements.`;
    state.complianceSet = data.id;
    form.reset();
    if (state.report) await renderCompliance(state.report);
  } catch (error) {
    message.textContent = error.message;
  }
}

async function saveVpatProfile(event) {
  event.preventDefault();
  const report = state.report;
  if (!report || report.id === "demo") return;
  const payload = {
    productName: $("#vpat-product").value, productVersion: $("#vpat-version").value, reportDate: $("#vpat-date").value,
    contact: $("#vpat-contact").value, description: $("#vpat-description").value, evaluationMethods: $("#vpat-methods").value, notes: $("#vpat-notes").value
  };
  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(report.id)}/vpat-profile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save product details.");
    $("#vpat-export-message").textContent = "Product details saved. Downloads now include them.";
  } catch (error) {
    $("#vpat-export-message").textContent = error.message;
  }
}

function appendFinancialExecution(container, review) {
  if (review?.kind !== "financial-step" || !review.execution || typeof review.execution !== "object" || Array.isArray(review.execution)) return;
  const execution = review.execution;
  container.append(textElement("p", `Environment: ${execution.environment ? productStatus(execution.environment) : "Not recorded"} · Build: ${execution.applicationVersion || "Not recorded"} · Browser / OS: ${execution.browser || "Not recorded"} · Assistive technology / method: ${execution.assistiveTechnology || "Not recorded"}`), textElement("p", `Authorization reference: ${execution.authorizationRef || "Not recorded"}`));
  if (Array.isArray(review.findingIds) && review.findingIds.length) container.append(textElement("p", `Linked findings: ${review.findingIds.join(", ")}`));
}

function renderFinancialReview(report) {
  const workspace = $("#financial-review-workspace");
  const financial = report.audit?.profile === "financial" ? report.audit.financial : null;
  workspace.hidden = !financial;
  const journeys = $("#financial-journeys"); journeys.replaceChildren();
  const summary = $("#financial-review-summary"); summary.replaceChildren();
  const blockers = $("#financial-review-blockers"); blockers.replaceChildren();
  if (!financial) return;
  $("#financial-review-notice").textContent = financial.notice || "Recorded manual evidence only — not a compliance score or completed professional audit.";
  $("#financial-completion-notice").textContent = financial.completionNotice || "Evidence references and reviewer identities are self-reported, not independently verified.";
  $("#financial-safety-notice").textContent = financial.safetyNotice || "Use an authorized sandbox or staging environment for consequential actions. Never submit real payments, trades, KYC documents or customer data for a test.";
  const readiness = $("#financial-readiness-status");
  readiness.textContent = financial.readiness?.status === "review-recorded" ? "Scenario reviews recorded" : "Review incomplete";
  readiness.className = `status-chip ${financial.readiness?.status === "review-recorded" ? "review-recorded" : "not-reviewed"}`;
  const totals = financial.summary || {};
  for (const [label, value] of [["Steps with recorded reviews", `${totals.stepsReviewed || 0} / ${totals.stepsTotal || 0}`], ["Recorded passes", totals.passed || 0], ["Recorded failures", totals.failed || 0], ["Blocked / pending", `${totals.blocked || 0} / ${totals.pending || 0}`]]) {
    const card = element("div"); card.append(textElement("strong", value), textElement("span", label)); summary.append(card);
  }
  summary.append(textElement("p", `${totals.journeysTotal || 0} guided journeys · ${totals.notApplicable || 0} recorded not applicable. Review counts describe evidence entries, not accessibility conformance.`, "form-note audit-wide"));
  for (const note of financial.readiness?.blockers || []) blockers.append(textElement("li", note));
  if (!blockers.children.length) blockers.append(textElement("li", "No workbook blockers listed. Qualified human conformance and regulatory review are still required."));
  for (const journey of financial.journeys || []) {
    const details = element("details", "financial-journey"); details.dataset.journeyId = journey.id;
    const heading = element("summary");
    const reviewed = journey.steps.filter((step) => step.status !== "not-reviewed").length;
    heading.append(textElement("strong", journey.title), textElement("span", `${reviewed} / ${journey.steps.length} steps reviewed`)); details.append(heading);
    const content = element("div", "financial-journey-content");
    content.append(textElement("p", journey.objective), textElement("h5", "Before you test"));
    const prerequisites = element("ul"); for (const item of journey.prerequisites || []) prerequisites.append(textElement("li", item)); content.append(prerequisites);
    for (const [index, step] of journey.steps.entries()) {
      const card = element("article", "financial-step"); card.dataset.stepId = step.id;
      const title = textElement("h5", `${index + 1}. ${step.title}`); card.append(title, textElement("span", productStatus(step.status || "not-reviewed"), `status-chip ${step.status || "not-reviewed"}`));
      if (step.requiresSandbox) card.append(textElement("span", "Sandbox / staging required", "financial-safety-label"));
      const information = element("dl");
      for (const [label, value] of [["Test instructions", step.instructions], ["Expected outcome", step.expected], ["Evidence to record", step.evidenceGuidance], ["Related WCAG criteria", (step.criteria || []).join(", ") || "Domain review — no automatic criterion decision"]]) information.append(textElement("dt", label), textElement("dd", value));
      card.append(information);
      if (step.review) {
        const latest = element("details", "financial-step-review"); latest.append(textElement("summary", `Latest review: ${step.review.reviewer} · ${formatDate(step.review.at)}`), textElement("p", step.review.notes), textElement("p", `Scope: ${step.review.scope}`), textElement("p", `Evidence: ${(step.review.evidence || []).join("; ")}`));
        appendFinancialExecution(latest, step.review); card.append(latest);
      }
      if (report.id !== "demo") {
        const button = textElement("button", "Record scenario review", "audit-review-button"); button.type = "button"; button.setAttribute("aria-label", `Record scenario review: ${step.title}`); button.addEventListener("click", () => openAuditReview("financial-step", step)); card.append(button);
      }
      content.append(card);
    }
    details.append(content); journeys.append(details);
  }
}

function setFinancialReviewFields(enabled, target = null) {
  const fieldset = $("#audit-financial-execution"); fieldset.hidden = !enabled; fieldset.disabled = !enabled;
  for (const input of fieldset.querySelectorAll("input:not([type=checkbox]), select")) { input.required = enabled; input.value = ""; }
  const findings = $("#audit-financial-findings"); findings.replaceChildren();
  $("#audit-financial-step-safety").textContent = !enabled ? "" : target?.requiresSandbox ? "This scenario requires a sandbox or staging environment. For a blocked or not-applicable review, record the actual constraints and supporting evidence. Do not execute consequential actions in production." : "Record only authorized tests. Production is limited to read-only observation. Never include passwords, OTPs, account numbers or customer data in this record.";
  if (!enabled) return;
  const available = [...new Map([...(state.report?.issues || []), ...(state.report?.incomplete || [])].filter((finding) => finding.id).map((finding) => [finding.id, finding])).values()];
  for (const [index, finding] of available.entries()) {
    const label = element("label", "audit-finding-option"); const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.value = finding.id; checkbox.id = `audit-financial-finding-${index}`; label.htmlFor = checkbox.id;
    const path = finding.target || finding.selector || "";
    const text = textElement("span", `${finding.id} · ${finding.ruleId || finding.rule || finding.title || "Finding"} · ${typeof path === "string" ? path : JSON.stringify(path)} · ${finding.reviewStatus === "needs-review" || finding.findingType === "needs-review" || (state.report?.incomplete || []).includes(finding) ? "Needs human review" : "Confirmed finding"}`);
    label.append(checkbox, text); findings.append(label);
  }
  if (!available.length) findings.append(textElement("p", "No existing findings to link. Record manual observations and evidence in this form.", "form-note"));
}

function openAuditReview(kind, target) {
  const form = $("#audit-review-form"); form.reset(); form.hidden = false;
  setFinancialReviewFields(kind === "financial-step", target);
  $("#audit-review-title").textContent = `Review ${target.criterion || target.title}`;
  $("#audit-review-kind").value = kind; $("#audit-review-target").value = target.id;
  const status = $("#audit-review-status"); status.replaceChildren();
  const placeholder = textElement("option", "Choose a documented decision"); placeholder.value = ""; status.append(placeholder);
  for (const value of kind === "criterion" || kind === "vpat-row" ? ["Supports", "Partially Supports", "Does Not Support", "Not Applicable"] : kind === "compliance-item" ? ["met", "partially-met", "not-met", "not-applicable"] : kind === "financial-step" ? ["pass", "fail", "blocked", "not-applicable"] : ["pass", "fail", "not-applicable"]) {
    const option = textElement("option", productStatus(value)); option.value = value;
    option.disabled = kind === "criterion" && target.issueCount > 0 && ["Supports", "Not Applicable"].includes(value); status.append(option);
  }
  $("#audit-review-message").textContent = "";
  form.scrollIntoView({ behavior: "smooth", block: "nearest" }); status.focus({ preventScroll: true });
}

async function saveAuditReview(event) {
  event.preventDefault();
  const reportId = state.report?.id;
  if (!reportId || reportId === "demo") return;
  const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true;
  const payload = { kind: $("#audit-review-kind").value, targetId: $("#audit-review-target").value, status: $("#audit-review-status").value, reviewer: $("#audit-review-reviewer").value, scope: $("#audit-review-scope").value, notes: $("#audit-review-notes").value, evidence: $("#audit-review-evidence").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) };
  if (payload.kind === "financial-step") {
    payload.execution = { environment: $("#audit-execution-environment").value, applicationVersion: $("#audit-execution-version").value, browser: $("#audit-execution-browser").value, assistiveTechnology: $("#audit-execution-at").value, authorizationRef: $("#audit-execution-authorization").value };
    payload.findingIds = [...$("#audit-financial-findings").querySelectorAll("input:checked")].map((input) => input.value);
  }
  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/reviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const report = await response.json(); if (!response.ok) throw new Error(report.error || "Could not save review.");
    if (state.report?.id !== reportId) return;
    state.report = report; renderVpat(report); setupExports(report);
    $("#audit-review-message").textContent = "Review entry saved. Original scan evidence and earlier review entries were preserved.";
  } catch (error) { if (state.report?.id === reportId) $("#audit-review-message").textContent = error.message; }
  finally { button.disabled = false; }
}

function setupExports(report) {
  for (const selector of ["#json-export", "#csv-export", "#csv-export-secondary", "#html-export"]) {
    const link = $(selector); const isJson = selector === "#json-export";
    if (report.id === "demo") { link.href = "#"; link.setAttribute("aria-disabled", "true"); }
    else { link.href = `/api/reports/${encodeURIComponent(report.id)}/exports/${isJson ? "json" : selector === "#html-export" ? "html" : "csv"}`; link.removeAttribute("aria-disabled"); link.download = ""; }
  }
}

export { renderVpat, setupExports, saveAuditReview, saveVpatProfile, updateVpatLinks, renderComplianceSet, importComplianceChecklist, setFinancialReviewFields };
