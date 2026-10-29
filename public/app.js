// Dashboard entry point: composition, report selection, navigation, and event bindings.
import { $, $$, textElement, stopReasonText, safeHostname, formatDuration, formatDate, fetchJson } from "./shared/ui.js";
import { state } from "./state.js";
import { sampleReport } from "./demo-report.js";
import { renderHealthAssessment, renderSeverity, renderCoverage, renderActivity, renderTabSummary } from "./features/overview.js";
import { allFindings, renderIssues } from "./features/findings.js";
import { createGraphView } from "./features/graph.js";
import { renderAssistiveTechnology } from "./features/assistive-technology.js";
// Preserve the public renderer used by existing report fixtures and integrations.
export { renderNvdaRun } from "./features/assistive-technology.js";
import { renderVpat, setupExports, saveAuditReview, saveVpatProfile, updateVpatLinks, renderComplianceSet, importComplianceChecklist, setFinancialReviewFields } from "./features/audit.js";
import { createScanController } from "./features/scan.js";
import { refreshComparisonSelectors, resetComparison, runComparison, renderComparison } from "./features/comparison.js";
import { renderActionExclusionSummary, loadCapabilities } from "./features/capabilities.js";
import { renderRemediation, renderBacklogRows, syncBacklogFromReport, trackSelectedFinding } from "./features/remediation.js";

// Wire cross-feature callbacks here, keeping feature modules free of import cycles.
const { renderGraph } = createGraphView({ showIssues: () => activateTab("issues") });
const { startScan, loadJourneys, runSelectedJourney } = createScanController({ renderReport, loadHistory, fetchReportWithAssessment });

function renderReport(report, assessment = null) {
  state.report = report;
  state.reportRequestId += 1;
  showDashboard("report");
  refreshHistoryOptions();
  const findings = allFindings(report);
  state.selectedIssueId = findings[0]?.id || null;
  state.selectedPage = null;
  state.selectedGraphNode = null;
  $("#report-toast").hidden = true;
  $("#graph-detail").replaceChildren(textElement("span", "Select a page or state"), textElement("strong", "Explore its route and findings"));
  const summary = report.summary || {};
  const domain = safeHostname(report.targetUrl);
  $("#report-domain").textContent = domain;
  const routeCount = summary.pagesScanned ?? report.pages.length;
  const stateCount = summary.statesObserved ?? report.graph?.nodes?.length ?? routeCount;
  const partial = { "in-progress": "Scan in progress", interrupted: "Interrupted scan", failed: "Failed scan", stopped: "Stopped scan" }[report.status];
  const partialReason = report.status === "stopped" ? stopReasonText(report.stopReason) || "The test browser was closed." : report.failure;
  $("#report-date").textContent = report.id === "demo"
    ? "Interactive sample · run a scan to replace it with live results"
    : partial ? `${partial} · partial results from ${routeCount} routes recorded before it stopped${partialReason ? ` · ${partialReason}` : ""}`
      : `Completed ${formatDate(report.completedAt)} · ${routeCount} routes · ${stateCount} states`;
  const bestPracticeCount = (report.bestPractices || []).length;
  const bestPracticeOption = $('#finding-status-filter option[value="best-practice"]');
  if (bestPracticeOption) bestPracticeOption.textContent = `Best practice only (${bestPracticeCount}, not scored)`;
  $("#metric-issues").textContent = summary.confirmedIssues ?? report.issues.length;
  $("#metric-review").textContent = summary.needsReview ?? report.incomplete?.length ?? 0;
  $("#metric-evidence").textContent = summary.evidenceScreenshots ?? report.issues.filter((entry) => entry.evidence).length;
  $("#metric-duration").textContent = formatDuration(summary.durationMs || 0);
  $("#metric-trend").textContent = `Across ${stateCount} observed states`;
  $("#metric-ai").textContent = `${summary.aiChecksUsed || 0} AI escalations`;
  renderHealthAssessment(assessment);
  $("#issue-tab-count").textContent = findings.length;
  setupExports(report);
  renderSeverity(report);
  renderCoverage(report);
  renderActivity(report);
  renderIssues();
  const crawlCoverageNote = $("#crawl-coverage-note");
  crawlCoverageNote.textContent = report.crawlTermination?.message || "";
  crawlCoverageNote.hidden = !report.crawlTermination?.message;
  renderTabSummary(report);
  renderGraph(report);
  renderAssistiveTechnology(report);
  renderVpat(report);
  void renderRemediation(report);
}
async function loadHistory() {
  try {
    const reports = await fetchJson("/api/reports");
    state.history = reports;
    if (state.report?.id === "demo") {
      const latest = reports.find((report) => report.completedAt);
      if (latest) {
        const loaded = await fetchReportWithAssessment(latest.id);
        renderReport(loaded.report, loaded.assessment);
      }
    }
    refreshHistoryOptions();
    refreshComparisonSelectors();
  } catch (error) {
    console.warn("Saved reports could not be loaded:", error.message);
  }
}

async function fetchReportWithAssessment(reportId) {
  const id = encodeURIComponent(reportId);
  const [report, assessment] = await Promise.all([
    fetchJson(`/api/reports/${id}`),
    fetchJson(`/api/reports/${id}/score`).catch(() => null)
  ]);
  return { report, assessment };
}

function refreshHistoryOptions() {
  const current = state.report;
  const currentSelect = $("#report-current");
  currentSelect.replaceChildren(new Option("Saved reports", ""));
  const statusLabels = { "in-progress": " · in progress", interrupted: " · interrupted", failed: " · failed", stopped: " · stopped" };
  for (const report of state.history) {
    currentSelect.append(new Option(`${safeHostname(report.targetUrl)} · ${formatDate(report.startedAt)}${statusLabels[report.status] || ""}`, report.id));
  }
  currentSelect.value = state.history.some((report) => report.id === current?.id) ? current.id : "";
}
function showDashboard(view) {
  document.querySelector(".hero").hidden = view === "comparison";
  $("#report-shell").hidden = view !== "report";
  $("#comparison-shell").hidden = view !== "comparison";
  document.body.classList.toggle("comparison-view", view === "comparison");
  updateWorkspaceNavigation(view === "comparison" ? "comparison" : document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab || "overview");
}

function updateWorkspaceNavigation(name) {
  $$("[data-workspace-nav]").forEach((control) => {
    if (control.dataset.workspaceNav === name) control.setAttribute("aria-current", "page");
    else control.removeAttribute("aria-current");
  });
}

async function openSelectedReport(reportId) {
  if (!reportId) return;
  const requestId = ++state.reportRequestId;
  $("#report-toast").hidden = true;
  try {
    const { report, assessment } = await fetchReportWithAssessment(reportId);
    if (requestId === state.reportRequestId) renderReport(report, assessment);
  } catch (error) {
    if (requestId !== state.reportRequestId) return;
    const toast = $("#report-toast");
    toast.textContent = `The selected report could not be opened: ${error.message}`;
    toast.hidden = false;
    refreshHistoryOptions();
  }
}
function activateTab(name, { focus = false } = {}) {
  updateWorkspaceNavigation(name);
  $$("[role=tab]").forEach((tab) => {
    const selected = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(selected));
    // Only the selected tab is in the Tab order; arrow keys move between tabs.
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  $$(".tab-panel").forEach((panel) => { panel.hidden = panel.id !== `panel-${name}`; });
  if (name === "crawl") renderGraph(state.report);
  if (name === "remediation" && state.report) void renderRemediation(state.report);
}

function handleTabKeys(event) {
  const tabs = $$('[role="tab"]');
  const index = tabs.indexOf(event.currentTarget);
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  activateTab(tabs[(next + tabs.length) % tabs.length].dataset.tab, { focus: true });
}
$("#scan-form").addEventListener("submit", startScan);
$("#journey-run").addEventListener("click", runSelectedJourney);
$("#exclude-action-labels").addEventListener("input", renderActionExclusionSummary);
void loadJourneys();
$("#audit-review-form").addEventListener("submit", saveAuditReview);
$("#vpat-profile-form").addEventListener("submit", saveVpatProfile);
$("#vpat-edition").addEventListener("change", () => updateVpatLinks(state.report));
$("#compliance-set").addEventListener("change", renderComplianceSet);
$("#compliance-import-form").addEventListener("submit", importComplianceChecklist);
$("#audit-review-cancel").addEventListener("click", () => { $("#audit-review-form").hidden = true; setFinancialReviewFields(false); });
$("#auth-enabled").addEventListener("change", (event) => {
  const enabled = event.target.checked;
  $("#auth-fields").hidden = !enabled;
  for (const selector of ["#login-url", "#login-username", "#login-password"]) $(selector).required = enabled;
  if (enabled && !$("#login-url").value && $("#target-url").value) $("#login-url").value = $("#target-url").value;
});
$("#issue-search").addEventListener("input", renderIssues);
$("#impact-filter").addEventListener("change", renderIssues);
$("#finding-status-filter").addEventListener("change", renderIssues);
$("#report-current").addEventListener("change", (event) => openSelectedReport(event.target.value));
$("#open-comparison").addEventListener("click", () => {
  showDashboard("comparison");
  refreshComparisonSelectors();
  $("#comparison-shell").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#back-to-report").addEventListener("click", () => {
  showDashboard("report");
  $("#report-shell").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#comparison-form").addEventListener("submit", runComparison);
$("#compare-reset").addEventListener("click", resetComparison);
for (const selector of ["#compare-before", "#compare-after"]) {
  $(selector).addEventListener("change", () => {
    state.comparisonRequestId += 1;
    state.comparison = null;
    $("#comparison-module").hidden = true;
    $("#comparison-toast").hidden = true;
    $("#compare-run").disabled = false;
    $("#compare-run").textContent = "Compare";
    refreshComparisonSelectors();
  });
}
$$("[data-comparison-filter]").forEach((button) => button.addEventListener("click", () => {
  state.comparisonFilter = button.dataset.comparisonFilter;
  renderComparison();
}));
$("#theme-toggle").addEventListener("click", () => {
  const dark = document.body.classList.toggle("dark");
  $("#theme-toggle").setAttribute("aria-pressed", String(dark));
});
$$("[data-workspace-nav]").forEach((control) => control.addEventListener("click", () => {
  const destination = control.dataset.workspaceNav;
  if (destination === "comparison") { $("#open-comparison").click(); $("#compare-before").focus({ preventScroll: true }); return; }
  showDashboard("report");
  if (destination === "scan") {
    updateWorkspaceNavigation("scan");
    $("#scan-workspace").scrollIntoView({ block: "start" });
    $("#target-url").focus({ preventScroll: true });
  } else {
    activateTab(destination, { focus: true });
    $("#report-shell").scrollIntoView({ block: "start" });
  }
}));
$$('[role="tab"]').forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  tab.addEventListener("keydown", handleTabKeys);
  tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
});
$("#remediation-filter").addEventListener("change", renderBacklogRows);
$("#remediation-sync").addEventListener("click", syncBacklogFromReport);
$("#track-finding").addEventListener("click", trackSelectedFinding);
$$(["#json-export", "#csv-export", "#csv-export-secondary", "#html-export"].join(",")).forEach((link) => link.addEventListener("click", (event) => {
  if (link.getAttribute("aria-disabled") === "true") event.preventDefault();
}));

// Scan setup stays first in both the visual and keyboard reading order.
$("#theme-toggle").setAttribute("aria-pressed", "false");
renderReport(sampleReport);
updateWorkspaceNavigation("scan");
loadHistory();
loadCapabilities();
