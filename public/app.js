const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const svgNs = "http://www.w3.org/2000/svg";

const state = {
  report: null,
  history: [],
  comparison: null,
  comparisonFilter: "all",
  comparisonSelectedKey: null,
  comparisonRequestId: 0,
  reportRequestId: 0,
  selectedIssueId: null,
  selectedPage: null,
  jobTimer: null
};

const sampleReport = {
  id: "demo",
  targetUrl: "https://storefront.example",
  startedAt: new Date(Date.now() - 18_000).toISOString(),
  completedAt: new Date().toISOString(),
  summary: { pagesScanned: 5, statesObserved: 5, confirmedIssues: 8, needsReview: 1, evidenceScreenshots: 8, durationMs: 18_240, aiChecksUsed: 1, byImpact: { critical: 1, serious: 3, moderate: 3, minor: 1 } },
  pages: [
    { url: "https://storefront.example", title: "Home", depth: 0, issueIds: ["demo-1", "demo-2", "demo-3"], technology: { openShadowRoots: 2, dialogs: 1, iframes: 0 } },
    { url: "https://storefront.example/products", title: "Products", depth: 1, issueIds: ["demo-4", "demo-5"], technology: { openShadowRoots: 1, dialogs: 0, iframes: 0 } },
    { url: "https://storefront.example/account", title: "Account", depth: 1, issueIds: ["demo-6"], technology: { openShadowRoots: 3, dialogs: 1, iframes: 1 } },
    { url: "https://storefront.example/cart", title: "Cart", depth: 2, issueIds: ["demo-7", "demo-8"], technology: { openShadowRoots: 0, dialogs: 1, iframes: 0 } },
    { url: "https://storefront.example/help", title: "Help center", depth: 2, issueIds: [], technology: { openShadowRoots: 0, dialogs: 0, iframes: 1 } }
  ],
  graph: {
    nodes: [
      { id: "https://storefront.example", label: "Home", url: "https://storefront.example", depth: 0, issueCount: 3, status: "issues" },
      { id: "https://storefront.example/products", label: "Products", url: "https://storefront.example/products", depth: 1, issueCount: 2, status: "issues" },
      { id: "https://storefront.example/account", label: "Account", url: "https://storefront.example/account", depth: 1, issueCount: 1, status: "issues" },
      { id: "https://storefront.example/cart", label: "Cart", url: "https://storefront.example/cart", depth: 2, issueCount: 2, status: "issues" },
      { id: "https://storefront.example/help", label: "Help center", url: "https://storefront.example/help", depth: 2, issueCount: 0, status: "pass" }
    ],
    edges: [
      { source: "https://storefront.example", target: "https://storefront.example/products", type: "link" },
      { source: "https://storefront.example", target: "https://storefront.example/account", type: "popup" },
      { source: "https://storefront.example/products", target: "https://storefront.example/cart", type: "link" },
      { source: "https://storefront.example/account", target: "https://storefront.example/help", type: "link" }
    ]
  },
  issues: [
    issue("demo-1", "image-alt", "critical", "Images must have alternate text", "#featured-product img", "1.1.1", "The product image has no text alternative, so screen reader users cannot identify the featured item."),
    issue("demo-2", "color-contrast", "serious", "Text must meet minimum color contrast", ".hero .subtitle", "1.4.3", "Foreground and background colors do not meet the 4.5:1 contrast requirement."),
    issue("demo-3", "button-name", "serious", "Buttons must have discernible text", ["product-card", "button.icon-only"], "4.1.2", "The icon button has no accessible name."),
    issue("demo-4", "aria-valid-attr-value", "moderate", "ARIA attributes must use valid values", "[aria-expanded=maybe]", "4.1.2", "The supplied ARIA state is not a permitted token."),
    { ...issue("demo-5", "focus-visible", "serious", "Keyboard focus indicator may not be visible", "a.product-link", "2.4.7", "No visible focus outline or box-shadow was observed during keyboard traversal."), source: "keyboard-traversal", state: "keyboard-tab-7" },
    issue("demo-6", "label", "moderate", "Form elements must have labels", "#account-dialog input[name=phone]", "1.3.1", "A phone number input in the account dialog has no programmatic label."),
    { ...issue("demo-7", "ai-alt-quality", "moderate", "Image alternative may not match visual meaning", "img.cart-thumbnail", "1.1.1", "The alternative says “image” but does not identify the product."), source: "gpt-4o-mini" },
    issue("demo-8", "landmark-unique", "minor", "Landmarks should have unique roles or labels", "aside:nth-of-type(2)", "1.3.1", "Two complementary landmarks expose the same unlabeled role.")
  ],
  incomplete: [{ ...issue("demo-review-1", "color-contrast", "moderate", "Color contrast requires manual confirmation", ".promo-copy", "1.4.3", "The background could not be determined because another element overlaps the text."), findingType: "needs-review", reviewStatus: "needs-review", reviewHistory: [{ at: new Date().toISOString(), status: "needs-review", source: "axe-core", message: "Automated contrast calculation was inconclusive." }] }],
  events: [
    { at: new Date(Date.now() - 17_000).toISOString(), type: "session", message: "Loaded persisted authenticated session." },
    { at: new Date(Date.now() - 14_000).toISOString(), type: "progress", message: "Injected axe-core into 5 application routes." },
    { at: new Date(Date.now() - 10_000).toISOString(), type: "dialog", message: "Scanned 3 modal and popup states." },
    { at: new Date(Date.now() - 6_000).toISOString(), type: "ai", message: "Escalated one uncertain image description." },
    { at: new Date().toISOString(), type: "complete", message: "Generated visual evidence and ACR draft." }
  ],
  acr: [
    { criterion: "WCAG 1.1.1 Non-text Content", level: "A", status: "Does Not Support", issueCount: 2, remarks: "Product imagery includes a missing alternative and one contextually weak description. Affected nodes: #featured-product img; img.cart-thumbnail" },
    { criterion: "WCAG 1.3.1 Info and Relationships", level: "A", status: "Partially Supports", issueCount: 2, remarks: "One dialog field has no programmatic label and duplicate complementary landmarks require review." },
    { criterion: "WCAG 1.4.3 Contrast (Minimum)", level: "AA", status: "Does Not Support", issueCount: 1, remarks: "Hero subtitle contrast is below the required ratio. Affected node: .hero .subtitle" },
    { criterion: "WCAG 2.4.7 Focus Visible", level: "AA", status: "Does Not Support", issueCount: 1, remarks: "Keyboard traversal found a product link without a visible focus treatment." },
    { criterion: "WCAG 4.1.2 Name, Role, Value", level: "A", status: "Does Not Support", issueCount: 2, remarks: "An icon button lacks a name and an expanded state uses an invalid ARIA value." }
  ]
};

function issue(id, ruleId, impact, help, target, wcag, summary) {
  return {
    id, ruleId, impact, help, target: Array.isArray(target) ? target : [target], wcag: [wcag],
    pageUrl: id === "demo-4" || id === "demo-5" ? "https://storefront.example/products" : id === "demo-6" ? "https://storefront.example/account" : id === "demo-7" || id === "demo-8" ? "https://storefront.example/cart" : "https://storefront.example",
    frameUrl: "https://storefront.example", state: "default", source: "axe-core", evidence: "/demo-evidence.svg", failureSummary: summary, description: summary
  };
}

function renderReport(report, assessment = null) {
  state.report = report;
  state.reportRequestId += 1;
  showDashboard("report");
  refreshHistoryOptions();
  const findings = allFindings(report);
  state.selectedIssueId = findings[0]?.id || null;
  state.selectedPage = null;
  const summary = report.summary || {};
  const domain = safeHostname(report.targetUrl);
  $("#report-domain").textContent = domain;
  const routeCount = summary.pagesScanned || report.pages.length;
  const stateCount = summary.statesObserved || report.graph?.nodes?.length || routeCount;
  $("#report-date").textContent = report.id === "demo"
    ? "Interactive sample · run a scan to replace it with live results"
    : `Completed ${formatDate(report.completedAt)} · ${routeCount} routes · ${stateCount} states`;
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
  renderEvidence(findings[0]);
  renderGraph(report);
  renderVpat(report);
}

function renderHealthAssessment(assessment) {
  const available = assessment?.status === "provisional" && Number.isFinite(assessment.score);
  const score = available ? assessment.score : null;
  const ring = $("#health-ring");
  ring.style.setProperty("--score-angle", `${score == null ? 0 : score * 36}deg`);
  ring.style.setProperty("--score-color", score == null ? "#dcfa8f" : score < 5.5 ? "#ffb096" : score < 8.5 ? "#f5d785" : "#dcfa8f");
  ring.setAttribute("aria-label", score == null ? "Observed accessibility score unavailable" : `Observed accessibility health ${score} out of 10, grade ${assessment.grade}`);
  $("#health-score-value").textContent = score == null ? "—" : score.toFixed(1);
  const grade = $("#health-grade");
  grade.textContent = score == null ? "Not scored" : `Grade ${assessment.grade} · Provisional`;
  grade.className = `health-grade${score != null && score < 5.5 ? " low" : ""}`;
  $("#health-title").textContent = score == null ? "A clearer picture of accessibility." :
    score >= 8.5 ? "A strong observed result." : score >= 6 ? "Progress with room to improve." : "Key barriers need attention.";
  $("#health-explainer").textContent = score == null
    ? "Run a completed scan to see a provisional score based on confirmed findings."
    : `${assessment.counts.confirmedIssues} confirmed findings across ${assessment.coverage.observedStates} observed states. This is a scan-based estimate, not a WCAG conformance grade.`;
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
  const events = (report.events || []).filter((event) => ["session", "progress", "dialog", "actions", "state", "ai", "complete"].includes(event.type)).slice(-5);
  for (const event of events) {
    const row = element("li");
    const detail = element("div"); detail.append(textElement("span", event.message), textElement("time", formatTime(event.at)));
    row.append(detail); list.append(row);
  }
  if (!events.length) list.append(textElement("li", "No scan events were recorded."));
}

function renderIssues() {
  const query = $("#issue-search").value.trim().toLowerCase();
  const impact = $("#impact-filter").value;
  const reviewStatus = $("#finding-status-filter").value;
  const list = $("#issue-list"); list.replaceChildren();
  const issues = allFindings(state.report).filter((item) => {
    if (impact !== "all" && item.impact !== impact) return false;
    if (reviewStatus !== "all" && item.reviewStatus !== reviewStatus) return false;
    if (state.selectedPage && item.pageUrl !== state.selectedPage) return false;
    const haystack = `${item.help} ${item.ruleId} ${item.pageUrl} ${formatTarget(item.target)}`.toLowerCase();
    return !query || haystack.includes(query);
  });
  for (const item of issues) {
    const button = element("button", `issue-item${item.id === state.selectedIssueId ? " selected" : ""}`);
    button.type = "button";
    const stripe = element("span", `severity-stripe ${item.impact}`);
    const copy = element("span");
    copy.append(textElement("strong", item.help), textElement("p", formatTarget(item.target)), textElement("small", `${shortPath(item.pageUrl)} · ${capitalize(item.impact)} · ${item.source}`));
    const chip = item.reviewStatus === "needs-review" ? "NEEDS REVIEW" : "WCAG " + (item.wcag?.join(", ") || "review");
    button.append(stripe, copy, textElement("span", chip, "wcag-chip"));
    button.addEventListener("click", () => {
      state.selectedIssueId = item.id;
      renderIssues(); renderEvidence(item);
    });
    list.append(button);
  }
  if (!issues.length) {
    const empty = element("div", "empty-list");
    empty.append(textElement("strong", state.selectedPage ? "No findings on this page" : "No matching findings"), textElement("p", "Clear the filter or select another crawl node."));
    list.append(empty);
  }
}

function renderEvidence(item) {
  if (!item) return;
  $("#evidence-title").textContent = item.help;
  $("#evidence-impact").textContent = item.reviewStatus === "needs-review" ? "Needs review" : item.impact;
  $("#evidence-impact").className = `impact-badge ${item.impact}`;
  $("#evidence-url").textContent = item.pageUrl;
  $("#evidence-wcag").textContent = item.wcag?.length ? item.wcag.map((id) => `SC ${id}`).join(", ") : "Manual review";
  $("#evidence-state").textContent = item.state || "default";
  $("#evidence-source").textContent = item.source || "axe-core";
  $("#evidence-review-status").textContent = item.reviewStatus === "needs-review" ? "Human decision pending" : "Confirmed by automation";
  $("#evidence-target").textContent = formatTarget(item.target);
  $("#evidence-summary").textContent = item.failureSummary || item.description || "Review this node manually.";
  const frame = $("#screenshot-frame");
  const image = $("#evidence-image");
  const caption = $("#evidence-caption");
  const evidence = item.evidence || item.contextEvidence;
  if (evidence) {
    image.src = evidence.startsWith("/") ? evidence : `/reports/${state.report.id}/${evidence}`;
    image.alt = `Screenshot highlighting ${item.help} at ${formatTarget(item.target)}`;
    frame.hidden = false;
    image.hidden = false;
    caption.hidden = item.evidenceKind !== "page-context";
    caption.textContent = item.evidenceKind === "page-context" ? "Page context only — the scanner could not draw a reliable element-level bounding box." : "";
  } else {
    frame.hidden = true;
    image.hidden = true;
    caption.hidden = true;
  }
  const historyBlock = $("#review-history-block");
  const historyList = $("#review-history");
  historyList.replaceChildren();
  const history = item.reviewHistory?.length ? item.reviewHistory : item.reviewStatus === "needs-review" ? [{
    at: state.report?.completedAt,
    source: item.source || "scanner",
    message: item.failureSummary || item.description || "Automation could not determine a conclusive pass or failure."
  }] : [];
  historyBlock.hidden = item.reviewStatus !== "needs-review";
  for (const entry of history) {
    const row = element("li");
    row.append(textElement("strong", entry.message || "Queued for human review"), textElement("time", `${formatDate(entry.at)} · ${entry.source || "scanner"}`));
    historyList.append(row);
  }
}

function allFindings(report) {
  return [
    ...(report.issues || []).map((item) => ({ ...item, reviewStatus: item.reviewStatus || "confirmed" })),
    ...(report.incomplete || []).map((item) => ({ ...item, impact: item.impact || "moderate", reviewStatus: "needs-review" }))
  ];
}

function renderGraph(report) {
  const svg = $("#crawl-graph"); svg.replaceChildren();
  const nodes = report.graph?.nodes || [];
  const edges = report.graph?.edges || [];
  if (!nodes.length) return;

  const definitions = document.createElementNS(svgNs, "defs");
  const marker = document.createElementNS(svgNs, "marker");
  marker.setAttribute("id", "graph-arrow");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9"); marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "7"); marker.setAttribute("markerHeight", "7");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrow = document.createElementNS(svgNs, "path");
  arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  marker.append(arrow); definitions.append(marker); svg.append(definitions);

  const layers = new Map();
  nodes.forEach((node) => {
    const depth = Number(node.depth || 0);
    if (!layers.has(depth)) layers.set(depth, []);
    layers.get(depth).push(node);
  });
  const columns = Math.min(3, Math.max(...[...layers.values()].map((items) => items.length)));
  const width = Math.max(980, columns * 330 + 100);
  const layerRows = new Map();
  let nextRow = 0;
  [...layers.entries()].sort(([a], [b]) => a - b).forEach(([depth, items]) => {
    layerRows.set(depth, nextRow);
    nextRow += Math.max(1, Math.ceil(items.length / columns));
  });
  const height = Math.max(600, nextRow * 165 + 90);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const positions = new Map();
  [...layers.entries()].sort(([a], [b]) => a - b).forEach(([depth, items]) => {
    const baseRow = layerRows.get(depth);
    items.forEach((node, index) => {
      const row = baseRow + Math.floor(index / columns);
      const itemsInRow = Math.min(columns, items.length - Math.floor(index / columns) * columns);
      const column = index % columns;
      const rowWidth = itemsInRow * 280 + Math.max(0, itemsInRow - 1) * 50;
      const startX = (width - rowWidth) / 2;
      positions.set(node.id, { x: startX + column * 330, y: 45 + row * 165 });
    });
  });

  edges.forEach((edge, index) => {
    const start = positions.get(edge.source); const end = positions.get(edge.target);
    if (!start || !end) return;
    const path = document.createElementNS(svgNs, "path");
    const sx = start.x + 140; const sy = start.y + 92; const ex = end.x + 140; const ey = end.y; const midY = (sy + ey) / 2;
    const edgeId = `graph-edge-${index}`;
    path.setAttribute("id", edgeId);
    path.setAttribute("d", `M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${midY}, ${ex} ${ey}`);
    path.setAttribute("class", `graph-edge ${edge.type === "popup" ? "popup" : ""}`);
    path.setAttribute("marker-end", "url(#graph-arrow)");
    const title = document.createElementNS(svgNs, "title");
    title.textContent = `${edge.label || edge.type || "navigate"}${edge.selector ? ` · ${edge.selector}` : ""}`;
    path.append(title);
    svg.append(path);
    const label = document.createElementNS(svgNs, "text");
    label.setAttribute("class", "graph-edge-label");
    const textPath = document.createElementNS(svgNs, "textPath");
    textPath.setAttribute("href", `#${edgeId}`);
    textPath.setAttribute("startOffset", "50%");
    textPath.setAttribute("text-anchor", "middle");
    textPath.textContent = truncate(edge.label || edge.type || "navigate", 34);
    label.append(textPath); svg.append(label);
  });
  for (const node of nodes) {
    const position = positions.get(node.id);
    const group = document.createElementNS(svgNs, "g");
    const status = ["failed", "error"].includes(node.status) ? "failed" : "scanned";
    group.setAttribute("class", `graph-node ${status}${state.selectedPage === node.url ? " selected" : ""}`);
    group.setAttribute("transform", `translate(${position.x},${position.y})`);
    group.setAttribute("tabindex", "0"); group.setAttribute("role", "button");
    group.setAttribute("aria-label", `${node.label}, ${status}, ${node.issueCount} findings`);
    const rect = document.createElementNS(svgNs, "rect"); rect.setAttribute("width", "280"); rect.setAttribute("height", "92"); rect.setAttribute("rx", "12");
    const title = document.createElementNS(svgNs, "text"); title.setAttribute("x", "16"); title.setAttribute("y", "27"); title.setAttribute("class", "node-title"); title.textContent = truncate(node.label, 32);
    const stateLine = document.createElementNS(svgNs, "text"); stateLine.setAttribute("x", "16"); stateLine.setAttribute("y", "52"); stateLine.setAttribute("class", "node-state"); stateLine.textContent = `${node.stateId || shortGraphId(node.id)} · ${status}${node.issueCount ? ` · ${node.issueCount} findings` : ""}`;
    const url = document.createElementNS(svgNs, "text"); url.setAttribute("x", "16"); url.setAttribute("y", "75"); url.setAttribute("class", "node-url"); url.textContent = truncate(node.url, 43);
    const tooltip = document.createElementNS(svgNs, "title"); tooltip.textContent = `${node.label}\n${node.url}\n${node.state || "page"} · ${status}`;
    const select = () => selectGraphNode(node);
    group.addEventListener("click", select);
    group.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); select(); } });
    group.append(rect, title, stateLine, url, tooltip); svg.append(group);
  }
}

function selectGraphNode(node) {
  state.selectedPage = state.selectedPage === node.url ? null : node.url;
  $("#graph-detail").replaceChildren(textElement("span", state.selectedPage ? `${node.issueCount} findings on selected route` : "Selection cleared"), textElement("strong", state.selectedPage || "Showing the complete crawl"));
  renderGraph(state.report);
  if (state.selectedPage) {
    activateTab("issues");
    renderIssues();
  }
}

function renderVpat(report) {
  const body = $("#vpat-body"); body.replaceChildren();
  for (const row of report.acr || []) {
    const tr = element("tr");
    const statusClass = row.status.toLowerCase().replaceAll(" ", "-");
    const status = textElement("span", row.status, `status-chip ${statusClass}`);
    const statusCell = element("td"); statusCell.append(status);
    tr.append(textElement("td", row.criterion), textElement("td", row.level), statusCell, textElement("td", row.issueCount), textElement("td", row.remarks));
    body.append(tr);
  }
}

function setupExports(report) {
  for (const selector of ["#json-export", "#csv-export", "#csv-export-secondary"]) {
    const link = $(selector); const isJson = selector === "#json-export";
    if (report.id === "demo") { link.href = "#"; link.setAttribute("aria-disabled", "true"); }
    else { link.href = `/reports/${report.id}/${isJson ? "vpat_draft.json" : "ACR_VPAT_Report.csv"}`; link.removeAttribute("aria-disabled"); link.download = ""; }
  }
}

async function startScan(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const authEnabled = form.has("authEnabled");
  const payload = {
    targetUrl: form.get("targetUrl"),
    maxPages: Number(form.get("maxPages")),
    maxDepth: Number(form.get("maxDepth")),
    aiEnabled: form.has("aiEnabled"),
    excludeActionLabels: form.get("excludeActionLabels"),
    auth: authEnabled ? {
      enabled: true,
      loginUrl: form.get("loginUrl"),
      username: form.get("loginUsername"),
      password: form.get("loginPassword"),
      postLoginValue: form.get("postLoginValue"),
      persist: form.has("persistSession"),
      aiEnabled: form.has("authAiEnabled"),
      emailSelector: form.get("emailSelector"),
      passwordSelector: form.get("passwordSelector"),
      submitSelector: form.get("submitSelector")
    } : { enabled: false }
  };
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  renderJobStatus({ status: "running", phase: "Launching browser", progress: 2, startedAt: new Date().toISOString(), events: [{ at: new Date().toISOString(), type: "session", message: "Preparing an isolated Chromium session." }] });
  try {
    const request = fetch("/api/scans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    $("#login-password").value = "";
    const response = await request;
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "Could not start scan.");
    pollJob(job.id, submit);
  } catch (error) {
    renderJobStatus({ status: "failed", phase: "Could not start scan", progress: 0, error: error.message, events: [{ at: new Date().toISOString(), type: "failed", message: error.message }] });
    submit.disabled = false;
  }
}

async function pollJob(jobId, submit) {
  clearTimeout(state.jobTimer);
  try {
    const response = await fetch(`/api/jobs/${jobId}`); const job = await response.json();
    if (!response.ok) throw new Error(job.error || "Could not read scan status.");
    renderJobStatus(job);
    if (job.status === "complete") {
      const { report, assessment } = await fetchReportWithAssessment(job.reportId);
      renderReport(report, assessment); await loadHistory(); submit.disabled = false;
      document.querySelector(".report-shell").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (job.status === "failed") { submit.disabled = false; return; }
    state.jobTimer = setTimeout(() => pollJob(jobId, submit), 1000);
  } catch (error) {
    renderJobStatus({ status: "failed", phase: "Status connection failed", progress: 0, error: error.message, events: [{ at: new Date().toISOString(), type: "failed", message: error.message }] });
    submit.disabled = false;
  }
}

function renderJobStatus(job) {
  const panel = $("#job-progress");
  const events = job.events || [];
  const lastEvent = events.at(-1);
  const hasWarning = ["page-error", "crawl-warning"].includes(lastEvent?.type);
  const waiting = /waiting|loading|authentication|identifying/i.test(`${job.phase || ""} ${lastEvent?.message || ""}`);
  const visualState = job.status === "failed" ? "failed" : job.status === "complete" ? "complete" : hasWarning ? "warning" : waiting ? "waiting" : "running";
  const percent = Math.max(0, Math.min(100, Number(job.progress || 0)));
  const icons = { running: "●", waiting: "◌", warning: "!", failed: "×", complete: "✓" };
  const labels = { running: job.phase || "Working", waiting: job.phase || "Waiting", warning: "Warning — scan continuing", failed: job.phase || "Scan failed", complete: "Scan complete" };
  const elapsed = job.startedAt ? formatElapsed(Date.now() - Date.parse(job.startedAt)) : null;
  const context = [elapsed ? `Elapsed ${elapsed}` : null, job.currentUrl ? truncate(job.currentUrl, 90) : null, job.warningCount ? `${job.warningCount} warning${job.warningCount === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");

  panel.hidden = false;
  panel.className = `job-progress ${visualState}`;
  panel.setAttribute("role", visualState === "failed" || visualState === "warning" ? "alert" : "status");
  $("#job-status-icon").textContent = icons[visualState];
  $("#job-status-label").textContent = labels[visualState];
  $("#job-message").textContent = job.error || lastEvent?.message || capitalize(job.status || "running");
  $("#job-detail").textContent = job.error ? `The scan stopped. Correct the problem and press Start scan to retry.${context ? ` ${context}` : ""}` : context || "The scanner is working. New steps will appear below.";
  $("#job-progressbar").value = percent;
  $("#job-progressbar").textContent = `${percent}%`;
  $("#job-progressbar").setAttribute("aria-label", `${labels[visualState]}: ${percent}%`);
  $("#job-percent").textContent = `${percent}%`;

  const list = $("#job-event-list"); list.replaceChildren();
  for (const event of events.slice(-4)) {
    const item = element("li", event.type || "event");
    item.append(textElement("strong", formatTime(event.at)), textElement("span", event.message || capitalize(event.type)));
    list.append(item);
  }
  if (visualState === "failed") panel.focus({ preventScroll: false });
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
  for (const report of state.history) {
    currentSelect.append(new Option(`${safeHostname(report.targetUrl)} · ${formatDate(report.startedAt)}`, report.id));
  }
  currentSelect.value = state.history.some((report) => report.id === current?.id) ? current.id : "";
}

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

function showDashboard(view) {
  document.querySelector(".hero").hidden = view === "comparison";
  $("#report-shell").hidden = view !== "report";
  $("#comparison-shell").hidden = view !== "comparison";
  document.body.classList.toggle("comparison-view", view === "comparison");
}

async function openSelectedReport(reportId) {
  if (!reportId) return;
  const requestId = ++state.reportRequestId;
  try {
    const { report, assessment } = await fetchReportWithAssessment(reportId);
    if (requestId === state.reportRequestId) renderReport(report, assessment);
  } catch (error) {
    if (requestId !== state.reportRequestId) return;
    showComparisonToast(`The selected report could not be opened: ${error.message}`);
    refreshHistoryOptions();
  }
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

async function loadCapabilities() {
  try {
    const health = await fetchJson("/api/health");
    const checkbox = $("#auth-ai-enabled");
    checkbox.disabled = !health.aiLoginAvailable;
    checkbox.checked = Boolean(health.aiLoginAvailable);
    $("#auth-ai-status").textContent = health.aiLoginAvailable
      ? "Available · credentials and input values are excluded"
      : "Add OPENAI_API_KEY to .env to enable";
  } catch {
    $("#auth-ai-status").textContent = "Availability could not be checked";
  }
}

function activateTab(name) {
  $$("[role=tab]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.tab === name)));
  $$(".tab-panel").forEach((panel) => { panel.hidden = panel.id !== `panel-${name}`; });
  if (name === "crawl") renderGraph(state.report);
}

function element(tag, className = "") { const node = document.createElement(tag); if (className) node.className = className; return node; }
function textElement(tag, text, className = "") { const node = element(tag, className); node.textContent = text; return node; }
function formatTarget(target) { return Array.isArray(target) ? target.flat(Infinity).join(" → ") : String(target || "Unknown node"); }
function countBy(items, key) { return items.reduce((result, item) => ({ ...result, [item[key]]: (result[item[key]] || 0) + 1 }), {}); }
function sum(pages, key) { return pages.reduce((total, page) => total + Number(page.technology?.[key] || 0), 0); }
function truncate(value, max) { return String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value); }
function shortGraphId(value) { let hash = 2166136261; for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 10); }
function capitalize(value) { return value ? value[0].toUpperCase() + value.slice(1) : ""; }
function safeHostname(url) { try { return new URL(url).hostname; } catch { return url || "Unknown target"; } }
function shortPath(url) { try { const parsed = new URL(url); return parsed.pathname || "/"; } catch { return url; } }
function formatDuration(ms) { return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`; }
function formatElapsed(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`; }
function formatDate(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "In progress"; }
function formatTime(value) { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
async function fetchJson(url) { const response = await fetch(url); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Request failed."); return data; }

$("#scan-form").addEventListener("submit", startScan);
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
$("#theme-toggle").addEventListener("click", () => document.body.classList.toggle("dark"));
$$('[role="tab"]').forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));
$$(["#json-export", "#csv-export", "#csv-export-secondary"].join(",")).forEach((link) => link.addEventListener("click", (event) => {
  if (link.getAttribute("aria-disabled") === "true") event.preventDefault();
}));

renderReport(sampleReport);
loadHistory();
loadCapabilities();
