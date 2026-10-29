import { $, $$, svgNs, element, textElement, truncate, safeHostname, formatDate, fetchJson } from "../shared/ui.js";
import { state } from "../state.js";

function refreshComparisonSelectors() {
  const before = $("#compare-before");
  const after = $("#compare-after");
  const selectedBefore = before.value;
  const selectedAfter = after.value;
  const beforeReport = state.history.find((report) => report.id === selectedBefore);
  const afterReport = state.history.find((report) => report.id === selectedAfter);
  before.replaceChildren(new Option("Choose first report", ""));
  after.replaceChildren(new Option("Choose second report", ""));
  const completed = state.history.filter((entry) => entry.completedAt);
  const availableBefore = (report) => !afterReport || (safeHostname(report.targetUrl) === safeHostname(afterReport.targetUrl) && report.id !== afterReport.id);
  const availableAfter = (report) => !beforeReport || (safeHostname(report.targetUrl) === safeHostname(beforeReport.targetUrl) && report.id !== beforeReport.id);
  for (const report of [...completed].sort((a, b) => Number(!availableBefore(a)) - Number(!availableBefore(b)))) {
    const label = `${safeHostname(report.targetUrl)} · ${formatDate(report.startedAt)}`;
    const beforeOption = new Option(label, report.id);
    beforeOption.disabled = !availableBefore(report);
    if (beforeOption.disabled) beforeOption.title = "Choose a different scan from the same application.";
    before.append(beforeOption);
  }
  for (const report of [...completed].sort((a, b) => Number(!availableAfter(a)) - Number(!availableAfter(b)))) {
    const afterOption = new Option(`${safeHostname(report.targetUrl)} · ${formatDate(report.startedAt)}`, report.id);
    afterOption.disabled = !availableAfter(report);
    if (afterOption.disabled) afterOption.title = "Choose a different scan from the same application.";
    after.append(afterOption);
  }
  before.value = selectedBefore && [...before.options].some((option) => option.value === selectedBefore && !option.disabled) ? selectedBefore : "";
  after.value = selectedAfter && [...after.options].some((option) => option.value === selectedAfter && !option.disabled) ? selectedAfter : "";
  const chosen = state.history.find((report) => report.id === (before.value || after.value));
  $("#comparison-form-hint").textContent = chosen
    ? `Showing selectable scans for ${safeHostname(chosen.targetUrl)} first. Use Reset comparison to choose another application.`
    : "Choose two different completed reports from the same application, in either order.";
}

function resetComparison() {
  state.comparisonRequestId += 1;
  state.comparison = null;
  state.comparisonFilter = "all";
  state.comparisonSelectedKey = null;
  $("#compare-before").value = "";
  $("#compare-after").value = "";
  $("#comparison-module").hidden = true;
  $("#comparison-toast").hidden = true;
  $("#compare-run").disabled = false;
  $("#compare-run").textContent = "Compare";
  refreshComparisonSelectors();
  $("#compare-before").focus();
}
async function runComparison(event) {
  event.preventDefault();
  const first = state.history.find((report) => report.id === $("#compare-before").value);
  const second = state.history.find((report) => report.id === $("#compare-after").value);
  const requestId = ++state.comparisonRequestId;
  if (!first || !second || !first.completedAt || !second.completedAt) {
    showComparisonToast("Choose two completed reports to compare.");
    return;
  }
  if (safeHostname(first.targetUrl) !== safeHostname(second.targetUrl)) {
    showComparisonToast("Cross-site report comparison is not allowed. Choose a scan from the same application.");
    return;
  }
  if (first.id === second.id || Date.parse(first.startedAt) === Date.parse(second.startedAt)) {
    showComparisonToast("Choose two different scans with distinct execution times.");
    return;
  }
  const [previous, current] = Date.parse(first.startedAt) < Date.parse(second.startedAt) ? [first, second] : [second, first];
  const button = $("#compare-run");
  button.disabled = true;
  button.textContent = "Comparing…";
  try {
    const comparison = await fetchJson(`/api/reports/${encodeURIComponent(current.id)}/compare/${encodeURIComponent(previous.id)}`);
    if (requestId !== state.comparisonRequestId) return;
    state.comparison = comparison;
    state.comparisonFilter = "all";
    state.comparisonSelectedKey = null;
    $("#comparison-toast").hidden = true;
    renderComparison();
  } catch (error) {
    if (requestId !== state.comparisonRequestId) return;
    showComparisonToast(error.message);
  } finally {
    if (requestId === state.comparisonRequestId) {
      button.disabled = false;
      button.textContent = "Compare";
    }
  }
}

function showComparisonToast(message) {
  const toast = $("#comparison-toast");
  toast.textContent = message;
  toast.hidden = false;
}

function renderComparison() {
  const comparison = state.comparison;
  if (!comparison) return;
  $("#comparison-module").hidden = false;
  $("#comparison-dates").textContent = `${comparison.domain} · Older ${formatDate(comparison.previous.completedAt)} → Current ${formatDate(comparison.current.completedAt)}`;
  const counts = comparison.counts;
  $("#comparison-all-count").textContent = counts.new + counts.fixed + counts.unresolved;
  for (const group of ["new", "fixed", "unresolved"]) {
    $(`#comparison-${group}-count`).textContent = counts[group];
    $(`#comparison-${group}-badge`).textContent = counts[group];
  }
  $$("[data-comparison-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.comparisonFilter === state.comparisonFilter)));
  const caveats = ["Confirmed findings only. An issue not detected in one run is not proof that the WCAG criterion passes."];
  if (comparison.excludedForCoverage) caveats.push(`${comparison.excludedForCoverage} unmatched findings excluded because the other scan did not cover the same page or state.`);
  if (comparison.excludedForReview) caveats.push(`${comparison.excludedForReview} unmatched findings excluded because the other result needs human review.`);
  $("#comparison-caveat").textContent = caveats.join(" ");
  renderComparisonRows();
  renderComparisonGraph("#compare-before-graph", comparison.graphs?.previous, "#compare-before-graph-summary", "compare-before-arrow");
  renderComparisonGraph("#compare-after-graph", comparison.graphs?.current, "#compare-after-graph-summary", "compare-after-arrow");
}

function renderComparisonGraph(selector, graph, summarySelector, markerId) {
  const svg = $(selector);
  svg.replaceChildren();
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  $(summarySelector).textContent = `${nodes.length} states/pages · ${edges.length} recorded transitions. This graph belongs only to this scan.`;
  if (!nodes.length) {
    svg.setAttribute("viewBox", "0 0 600 100");
    const empty = document.createElementNS(svgNs, "text");
    empty.setAttribute("x", "25"); empty.setAttribute("y", "50");
    empty.setAttribute("class", "comparison-graph-detail");
    empty.textContent = "No crawl graph was recorded for this scan.";
    svg.append(empty);
    return;
  }

  const layers = new Map();
  nodes.forEach((node) => {
    const depth = Math.max(0, Number(node.depth || 0));
    if (!layers.has(depth)) layers.set(depth, []);
    layers.get(depth).push(node);
  });
  const columns = Math.min(2, Math.max(...[...layers.values()].map((items) => items.length)));
  const width = Math.max(620, columns * 300 + 60);
  const positions = new Map();
  let row = 0;
  [...layers.entries()].sort(([a], [b]) => a - b).forEach(([, items]) => {
    items.forEach((node, index) => positions.set(node.id, {
      x: 28 + (index % columns) * 300,
      y: 30 + (row + Math.floor(index / columns)) * 128
    }));
    row += Math.max(1, Math.ceil(items.length / columns));
  });
  const height = Math.max(140, row * 128 + 35);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const defs = document.createElementNS(svgNs, "defs");
  const marker = document.createElementNS(svgNs, "marker");
  marker.setAttribute("id", markerId);
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9"); marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "6"); marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto");
  const tip = document.createElementNS(svgNs, "path");
  tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  tip.setAttribute("fill", "#8ca0bc");
  marker.append(tip); defs.append(marker); svg.append(defs);

  for (const edge of edges) {
    const start = positions.get(edge.source);
    const end = positions.get(edge.target);
    if (!start || !end) continue;
    const line = document.createElementNS(svgNs, "path");
    const sx = start.x + 130; const sy = start.y + 79;
    const ex = end.x + 130; const ey = end.y;
    line.setAttribute("d", `M ${sx} ${sy} C ${sx} ${(sy + ey) / 2}, ${ex} ${(sy + ey) / 2}, ${ex} ${ey}`);
    line.setAttribute("class", `comparison-graph-edge ${edge.type === "popup" ? "popup" : ""}`);
    line.setAttribute("marker-end", `url(#${markerId})`);
    const title = document.createElementNS(svgNs, "title");
    title.textContent = edge.label || edge.type || "navigate";
    line.append(title); svg.append(line);
  }
  for (const node of nodes) {
    const position = positions.get(node.id);
    const group = document.createElementNS(svgNs, "g");
    group.setAttribute("transform", `translate(${position.x},${position.y})`);
    const rect = document.createElementNS(svgNs, "rect");
    rect.setAttribute("width", "260"); rect.setAttribute("height", "79"); rect.setAttribute("rx", "10");
    rect.setAttribute("class", `comparison-graph-node ${node.status === "failed" ? "failed" : ""}`);
    const label = document.createElementNS(svgNs, "text");
    label.setAttribute("x", "12"); label.setAttribute("y", "27"); label.setAttribute("class", "comparison-graph-label");
    label.textContent = truncate(node.label || node.url || "State", 31);
    const detail = document.createElementNS(svgNs, "text");
    detail.setAttribute("x", "12"); detail.setAttribute("y", "49"); detail.setAttribute("class", "comparison-graph-detail");
    detail.textContent = `${node.state || "page"} · ${node.issueCount || 0} findings`;
    const route = document.createElementNS(svgNs, "text");
    route.setAttribute("x", "12"); route.setAttribute("y", "67"); route.setAttribute("class", "comparison-graph-detail");
    route.textContent = truncate(node.url || "", 39);
    const title = document.createElementNS(svgNs, "title");
    title.textContent = `${node.label || "State"}\n${node.url || ""}`;
    group.append(rect, label, detail, route, title); svg.append(group);
  }
}

function renderComparisonRows() {
  const body = $("#comparison-table-body");
  body.replaceChildren();
  const labels = { new: "New", fixed: "Fixed", unresolved: "Unresolved" };
  const groups = state.comparisonFilter === "all" ? ["new", "fixed", "unresolved"] : [state.comparisonFilter];
  let firstSelection = null;
  let matchingSelection = null;
  for (const group of groups) {
    for (const finding of state.comparison.groups[group] || []) {
      const key = JSON.stringify([group, finding.criterion, finding.ruleId, finding.target, finding.page, finding.state]);
      const row = element("tr");
      const status = element("td");
      status.append(textElement("span", labels[group], `delta-badge delta-${group}`));
      const rule = element("td");
      rule.append(textElement("strong", `WCAG ${finding.criterion}`), textElement("div", finding.ruleId));
      const target = element("td");
      target.append(textElement("code", finding.target));
      const select = textElement("button", "View screenshots", "comparison-evidence-select");
      select.type = "button";
      select.setAttribute("aria-pressed", "false");
      select.addEventListener("click", () => selectComparisonFinding({ key, group, finding, row, button: select }, true));
      target.append(select);
      const location = element("td");
      location.append(textElement("strong", finding.page), textElement("div", finding.state));
      row.append(status, rule, target, location);
      row.addEventListener("click", (event) => { if (event.target !== select) select.click(); });
      body.append(row);
      const selection = { key, group, finding, row, button: select };
      firstSelection ||= selection;
      if (key === state.comparisonSelectedKey) matchingSelection = selection;
    }
  }
  if (matchingSelection || firstSelection) selectComparisonFinding(matchingSelection || firstSelection);
  else $("#comparison-evidence").hidden = true;
  if (!body.children.length) {
    const row = element("tr");
    const cell = textElement("td", "No comparable findings in this category.");
    cell.colSpan = 4;
    row.append(cell);
    body.append(row);
  }
}

function selectComparisonFinding(selection, scrollToEvidence = false) {
  state.comparisonSelectedKey = selection.key;
  $$("#comparison-table-body .comparison-evidence-select").forEach((button) => button.setAttribute("aria-pressed", String(button === selection.button)));
  $$("#comparison-table-body tr").forEach((row) => row.classList.toggle("selected", row === selection.row));
  const { group, finding } = selection;
  $("#comparison-evidence").hidden = false;
  $("#comparison-evidence-title").textContent = finding.help || finding.ruleId;
  $("#comparison-evidence-detail").textContent = `WCAG ${finding.criterion} · ${finding.target} · ${finding.page} · ${finding.state}`;
  const badge = $("#comparison-evidence-status");
  badge.textContent = { new: "New issue", fixed: "Fixed issue", unresolved: "Unresolved issue" }[group];
  badge.className = `delta-badge delta-${group}`;
  $("#compare-before-evidence-date").textContent = formatDate(state.comparison.previous.completedAt);
  $("#compare-after-evidence-date").textContent = formatDate(state.comparison.current.completedAt);
  renderComparisonCapture("before", group === "fixed" ? finding.evidence : finding.previousEvidence,
    group === "new" ? "No matching failure was recorded in this scan. This is not proof the element passed." : "No saved screenshot for this finding in the earlier scan.", finding);
  renderComparisonCapture("after", group === "fixed" ? finding.currentEvidence : finding.evidence,
    group === "fixed" ? "The failure was not recorded in this scan. This is not proof the element passed." : "No saved screenshot for this finding in the later scan.", finding);
  if (scrollToEvidence) $("#comparison-evidence").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderComparisonCapture(side, evidence, missingMessage, finding) {
  const container = $(`#compare-${side}-evidence-image`);
  const note = $(`#compare-${side}-evidence-note`);
  container.replaceChildren();
  if (!evidence?.url) {
    container.append(textElement("div", "Screenshot unavailable", "comparison-evidence-empty"));
    note.textContent = missingMessage;
    return;
  }
  const link = element("a");
  link.href = evidence.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `Open full-size ${side === "before" ? "earlier" : "later"} scan screenshot for ${finding.target}`);
  const image = element("img");
  image.src = evidence.url;
  image.alt = `${side === "before" ? "Earlier" : "Later"} scan screenshot for ${finding.target}`;
  image.loading = "lazy";
  image.addEventListener("error", () => {
    if (!container.contains(link)) return;
    container.replaceChildren(textElement("div", "Saved screenshot could not be loaded", "comparison-evidence-empty"));
    note.textContent = "The report references evidence, but the image file is missing or inaccessible.";
  });
  link.append(image);
  container.append(link);
  note.textContent = evidence.kind === "page-context"
    ? "Page context only; this capture may show a different interaction state and does not prove the element passed. Click to open full size."
    : "Issue-highlighted capture. Click to open full size.";
}

// Same rules as parseActionExclusions in src/browser/action-exclusions.js, so
// the summary lists exactly the entries the scan will apply.

export { refreshComparisonSelectors, resetComparison, runComparison, renderComparison };
