import { $, element, textElement, formatTarget, capitalize, shortPath, formatDate } from "../shared/ui.js";
import { state } from "../state.js";

function renderIssues() {
  const query = $("#issue-search").value.trim().toLowerCase();
  const impact = $("#impact-filter").value;
  const reviewStatus = $("#finding-status-filter").value;
  const list = $("#issue-list"); list.replaceChildren();
  const issues = allFindings(state.report, { includeBestPractices: reviewStatus === "best-practice" }).filter((item) => {
    if (impact !== "all" && item.impact !== impact) return false;
    if (reviewStatus !== "all" && item.reviewStatus !== reviewStatus) return false;
    if (state.selectedPage && item.pageUrl !== state.selectedPage && !(item.alsoObservedOn || []).some((entry) => entry.pageUrl === state.selectedPage)) return false;
    const node = state.selectedGraphNode;
    if (node && node.state && node.state !== "page") {
      const findingState = node.findingState || `${node.state}:${String(node.label || "").slice(0, 60)}`;
      if (item.state !== findingState) return false;
    }
    const haystack = `${item.help} ${item.ruleId} ${item.pageUrl} ${formatTarget(item.target)}`.toLowerCase();
    return !query || haystack.includes(query);
  });
  const selected = issues.find((item) => item.id === state.selectedIssueId) || issues[0];
  state.selectedIssueId = selected?.id || null;
  renderEvidence(selected);
  for (const item of issues) {
    const button = element("button", `issue-item${item.id === state.selectedIssueId ? " selected" : ""}`);
    button.type = "button";
    const stripe = element("span", `severity-stripe ${item.impact}`);
    const copy = element("span");
    copy.append(textElement("strong", item.help), textElement("p", formatTarget(item.target)), textElement("small", `${shortPath(item.pageUrl)} · ${capitalize(item.impact)} · ${item.source}`));
    const chip = item.reviewStatus === "needs-review" ? "NEEDS REVIEW" : item.reviewStatus === "best-practice" ? "BEST PRACTICE" : "WCAG " + (item.wcag?.join(", ") || "review");
    button.append(stripe, copy, textElement("span", chip, "wcag-chip"));
    button.addEventListener("click", () => {
      state.selectedIssueId = item.id;
      renderIssues();
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
  if (!item) {
    $("#evidence-title").textContent = "No matching finding selected";
    for (const id of ["impact", "url", "wcag", "state", "source", "review-status", "target"]) $("#evidence-" + id).textContent = "—";
    $("#evidence-impact").className = "impact-badge";
    $("#evidence-summary").textContent = "Choose a finding or clear the filters to inspect its evidence.";
    $("#screenshot-frame").hidden = true;
    $("#evidence-image").hidden = true;
    $("#evidence-image").removeAttribute("src");
    $("#evidence-caption").hidden = true;
    $("#review-history-block").hidden = true;
    $("#review-history").replaceChildren();
    return;
  }
  $("#evidence-title").textContent = item.help;
  $("#evidence-impact").textContent = item.reviewStatus === "needs-review" ? "Needs review" : item.impact;
  $("#evidence-impact").className = `impact-badge ${item.impact}`;
  $("#evidence-url").textContent = item.pageUrl;
  $("#evidence-wcag").textContent = item.wcag?.length ? item.wcag.map((id) => `SC ${id}`).join(", ") : item.reviewStatus === "best-practice" ? "Best practice (no WCAG criterion)" : "Manual review";
  $("#evidence-state").textContent = item.state || "default";
  $("#evidence-source").textContent = item.source || "axe-core";
  $("#evidence-review-status").textContent = item.reviewStatus === "needs-review" ? "Human decision pending" : item.reviewStatus === "best-practice" ? "Best practice — not counted or scored" : "Confirmed by automation";
  $("#evidence-target").textContent = formatTarget(item.target);
  const otherPages = (item.alsoObservedOn || []).length;
  $("#evidence-summary").textContent = `${item.failureSummary || item.description || "Review this node manually."}${otherPages ? ` Also observed in the shared site navigation on ${otherPages} other page${otherPages === 1 ? "" : "s"}.` : ""}`;
  const frame = $("#screenshot-frame");
  const image = $("#evidence-image");
  const caption = $("#evidence-caption");
  const evidence = item.evidence || item.contextEvidence;
  if (evidence) {
    image.src = evidence.startsWith("/") ? evidence : `/reports/${state.report.id}/${evidence}`;
    image.alt = `Screenshot highlighting ${item.help} at ${formatTarget(item.target)}`;
    frame.hidden = false;
    image.hidden = false;
    const captions = {
      "page-context": "Page context only — the scanner could not draw a reliable element-level bounding box.",
      condition: "Captured under the test condition (for example a 320 px viewport, 200% zoom width or WCAG text spacing), not the default view.",
      screen: "Full device screen at the time of capture; locate the element with its bounds and resource ID."
    };
    caption.hidden = !captions[item.evidenceKind];
    caption.textContent = captions[item.evidenceKind] || "";
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
  $("#track-finding-block").hidden = !state.report || state.report.id === "demo";
  $("#track-finding-message").textContent = "";
  for (const entry of history) {
    const row = element("li");
    row.append(textElement("strong", entry.message || "Queued for human review"), textElement("time", `${formatDate(entry.at)} · ${entry.source || "scanner"}`));
    historyList.append(row);
  }
}

function allFindings(report, { includeBestPractices = false } = {}) {
  return [
    ...(report.issues || []).map((item) => ({ ...item, reviewStatus: item.reviewStatus || "confirmed" })),
    ...(report.incomplete || []).map((item) => ({ ...item, impact: item.impact || "moderate", reviewStatus: "needs-review" })),
    ...(includeBestPractices ? (report.bestPractices || []).map((item) => ({ ...item, impact: item.impact || "minor", reviewStatus: "best-practice" })) : [])
  ];
}

export { renderIssues, allFindings };
