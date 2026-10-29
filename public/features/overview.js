import { $, element, textElement, countBy, sum, capitalize, formatTime } from "../shared/ui.js";

function renderHealthAssessment(assessment) {
  const available = assessment?.status === "provisional" && Number.isFinite(assessment.score);
  const score = available ? assessment.score : null;
  const ring = $("#health-ring");
  ring.style.setProperty("--score-angle", `${score == null ? 0 : score * 36}deg`);
  const scoreTone = (value) => value == null ? "neutral" : value < 5.5 ? "low" : value < 8.5 ? "medium" : "high";
  $(".health-stage").dataset.scoreTone = scoreTone(score);
  ring.setAttribute("aria-label", score == null ? "Observed accessibility score unavailable" : `Observed accessibility health ${score} out of 10, grade ${assessment.grade}`);
  $("#health-score-value").textContent = score == null ? "—" : score.toFixed(1);
  const grade = $("#health-grade");
  grade.textContent = score == null ? "Not scored" : `Grade ${assessment.grade} · Provisional`;
  grade.className = `health-grade${score != null && score < 5.5 ? " low" : ""}`;
  $("#health-title").textContent = score == null ? "A clearer picture of accessibility." :
    score >= 8.5 ? "A strong observed result." : score >= 6 ? "Progress with room to improve." : "Key barriers need attention.";
  $("#health-explainer").textContent = score == null
    ? "Run a completed scan to see a provisional score based on confirmed findings."
    : `${assessment.counts.confirmedIssues} confirmed WCAG findings across ${assessment.coverage.scannedPages} scanned pages (${assessment.coverage.observedStates} observed states). Best-practice findings are listed separately and not scored. This is a scan-based estimate, not a WCAG conformance grade.`;
  $("#health-states").textContent = assessment?.coverage?.observedStates ?? "—";
  $("#health-confidence").textContent = assessment?.confidence ?? "—";
  $("#health-review").textContent = assessment?.counts?.needsReview ?? "—";
  $("#health-method-text").textContent = assessment?.methodology
    ? `${assessment.methodology.formula}. Critical 2.4, serious 1.3, moderate 0.55, minor 0.2. Grade bands: A+ ≥9.5, A ≥8.5, B ≥7, C ≥5.5, D ≥4, F below 4. ${assessment.methodology.note}`
    : "A heuristic for observed scan results, not a WCAG conformance score.";
  const list = $("#health-principle-list");
  list.replaceChildren();
  for (const principle of assessment?.principles || [
    { label: "Perceivable", score: null }, { label: "Operable", score: null },
    { label: "Understandable", score: null }, { label: "Robust", score: null }
  ]) {
    const row = element("div", "health-principle-row");
    row.dataset.scoreTone = scoreTone(principle.score);
    const head = element("div");
    head.append(textElement("span", principle.label), textElement("strong", principle.score == null ? "—" : `${principle.score.toFixed(1)}/10`));
    const bar = element("progress");
    bar.max = 10;
    bar.value = principle.score ?? 0;
    bar.setAttribute("aria-label", `${principle.label} observed score`);
    row.append(head, bar);
    list.append(row);
  }
}

function renderSeverity(report) {
  const impacts = report.summary?.byImpact || countBy(report.issues, "impact");
  const total = Math.max(1, report.issues.length);
  const colors = { critical: "#6d385e", serious: "#ef7d67", moderate: "#e6b954", minor: "#8aa79a" };
  let position = 0;
  const stops = [];
  for (const level of ["critical", "serious", "moderate", "minor"]) {
    const next = position + ((impacts[level] || 0) / total) * 100;
    stops.push(`${colors[level]} ${position}% ${next}%`);
    position = next;
  }
  $("#severity-donut").style.background = `conic-gradient(${stops.join(",")})`;
  $("#donut-total").textContent = report.issues.length;
  const list = $("#severity-legend");
  list.replaceChildren();
  for (const level of ["critical", "serious", "moderate", "minor"]) {
    const row = element("li");
    const dot = element("i"); dot.style.background = colors[level];
    row.append(dot, textElement("span", capitalize(level)), textElement("strong", impacts[level] || 0));
    list.append(row);
  }
}

function renderCoverage(report) {
  const pages = report.pages || [];
  const total = Math.max(1, pages.length);
  const surfaces = [
    ["States observed", report.summary?.statesObserved || report.graph?.nodes?.length || pages.length, Math.max(1, report.summary?.statesObserved || report.graph?.nodes?.length || pages.length)],
    ["Open Shadow roots", sum(pages, "openShadowRoots"), Math.max(1, sum(pages, "openShadowRoots"))],
    ["Dialog states", sum(pages, "dialogs"), Math.max(1, sum(pages, "dialogs") + 1)],
    ["Embedded frames", sum(pages, "iframes"), Math.max(1, sum(pages, "iframes") + 1)]
  ];
  const wrap = $("#coverage-bars"); wrap.replaceChildren();
  for (const [label, value, max] of surfaces) {
    const row = element("div", "bar-row");
    const head = element("div"); head.append(textElement("span", label), textElement("strong", value));
    const track = element("div", "bar-track");
    const bar = element("span"); bar.style.width = `${Math.max(value ? 13 : 0, Math.min(100, (value / max) * 100))}%`;
    track.append(bar); row.append(head, track); wrap.append(row);
  }
}

function renderActivity(report) {
  const list = $("#activity-list"); list.replaceChildren();
  const events = (report.events || []).filter((event) => ["session", "progress", "dialog", "actions", "state", "ai", "blocker-detected", "blocker-recovery", "blocker-resolved", "blocker-user-action-required", "crawl-termination", "complete",
    "browser-closed", "scan-stopped", "nvda-paused", "nvda-resumed", "tab-returned-home", "tab-external"].includes(event.type)).slice(-5);
  for (const event of events) {
    const row = element("li");
    const detail = element("div"); detail.append(textElement("span", event.message), textElement("time", formatTime(event.at)));
    row.append(detail); list.append(row);
  }
  if (!events.length) list.append(textElement("li", "No scan events were recorded."));
}

// Tabs the site opened during the crawl. Same-site tabs were tested in place
// (pages marked openedInNewTab); the others were closed untested and are listed
// as plain text, never links, because they can be logout or delete URLs.
function renderTabSummary(report) {
  const block = $("#tab-summary");
  if (!block) return;
  const external = Array.isArray(report.externalTabs) ? report.externalTabs : [];
  const tested = (report.pages || []).filter((page) => page.openedInNewTab).length;
  block.hidden = !external.length && !tested;
  $("#tab-summary-count").textContent = `${tested} tested in place · ${external.length} not tested`;
  const words = (value) => capitalize(String(value || "").replace(/[_-]+/g, " ").trim());
  const list = $("#external-tabs-list"); list.replaceChildren();
  for (const tab of external) {
    const row = element("li");
    row.append(textElement("strong", tab.label || "Unlabelled control"), textElement("span", tab.url || "Address not recorded"),
      textElement("small", [words(tab.reason) || "Not tested", tab.source ? `Source: ${words(tab.source)}` : ""].filter(Boolean).join(" · ")));
    list.append(row);
  }
  list.hidden = !external.length;
}

export { renderHealthAssessment, renderSeverity, renderCoverage, renderActivity, renderTabSummary };
