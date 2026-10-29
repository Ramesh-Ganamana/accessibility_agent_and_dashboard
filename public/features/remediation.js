import { $, element, textElement, truncate, capitalize, safeHostname, shortPath, formatDate, fetchJson } from "../shared/ui.js";
import { state } from "../state.js";

const BACKLOG_CLOSED = new Set(["fixed", "verified", "wont-fix", "false-positive"]);
const BACKLOG_STATUS_LABELS = { open: "Open", "in-progress": "In progress", fixed: "Fixed (awaiting retest)", verified: "Verified", reopened: "Reopened", "wont-fix": "Will not fix", "false-positive": "False positive" };

async function renderRemediation(report) {
  const host = report?.id === "demo" ? "" : safeHostname(report?.targetUrl || "");
  const body = $("#remediation-body");
  $("#remediation-sync").disabled = !host || report.status !== "complete";
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) {
    body.replaceChildren(emptyRow("The remediation backlog is available for saved scans."));
    $("#remediation-summary").replaceChildren();
    $("#remediation-tab-count").textContent = "0";
    return;
  }
  const requestId = (state.backlogRequestId = (state.backlogRequestId || 0) + 1);
  try {
    const backlog = await fetchJson(`/api/backlog/${encodeURIComponent(host)}`);
    if (requestId !== state.backlogRequestId) return;
    state.backlog = backlog;
    $("#remediation-export").href = `/api/backlog/${encodeURIComponent(host)}/export.csv`;
    renderBacklogRows();
  } catch (error) {
    body.replaceChildren(emptyRow(`The backlog could not be loaded: ${error.message}`));
  }
}

function emptyRow(message) {
  const row = element("tr");
  const cell = textElement("td", message);
  cell.colSpan = 5;
  row.append(cell);
  return row;
}

function renderBacklogRows() {
  const backlog = state.backlog;
  if (!backlog) return;
  const summary = backlog.summary || {};
  $("#remediation-tab-count").textContent = String(summary.open ?? 0);
  const summaryNode = $("#remediation-summary");
  summaryNode.replaceChildren();
  for (const [label, value] of [["Open", summary.open ?? 0], ["Reopened", summary.reopened ?? 0], ["Verify (not found in latest scan)", summary.notFoundAwaitingVerification ?? 0], ["Total tracked", summary.total ?? 0]]) {
    const card = element("div");
    card.append(textElement("strong", String(value)), textElement("span", label));
    summaryNode.append(card);
  }
  const filter = $("#remediation-filter").value;
  const items = backlog.items.filter((item) => filter === "all" ? true
    : filter === "closed" ? BACKLOG_CLOSED.has(item.status)
      : filter === "verify" ? item.latestScan === "not-found" && !["verified", "wont-fix", "false-positive"].includes(item.status)
        : !BACKLOG_CLOSED.has(item.status));
  const body = $("#remediation-body");
  body.replaceChildren();
  if (!items.length) { body.append(emptyRow(backlog.items.length ? "No items match this filter." : "No findings are tracked for this site yet.")); return; }
  for (const item of items.slice(0, 300)) body.append(backlogRow(item));
}

function backlogRow(item) {
  const row = element("tr");
  const issue = element("td");
  issue.append(textElement("strong", item.help), textElement("small", [item.wcag?.length ? `WCAG ${item.wcag.join(", ")}` : null, capitalize(item.impact || ""), item.ruleId].filter(Boolean).join(" · ")));
  const where = element("td");
  where.append(textElement("span", item.region === "global" ? "Site-wide navigation" : shortPath(item.documentUrl || item.pageUrl)), textElement("code", truncate(item.target || "", 120)));
  const latest = element("td");
  latest.append(textElement("span", { present: "Found in latest scan", "not-found": "Not found — verify the fix manually", "not-covered": "Page not covered by latest scan" }[item.latestScan] || "—"),
    textElement("small", `Last seen ${formatDate(item.lastSeen?.at)}`));
  const controls = element("td", "remediation-controls");
  const id = `backlog-${item.key}`;
  const status = element("select");
  status.id = `${id}-status`;
  for (const [value, label] of Object.entries(BACKLOG_STATUS_LABELS)) status.append(new Option(label, value, false, value === item.status));
  const owner = element("input"); owner.id = `${id}-owner`; owner.maxLength = 200; owner.value = item.owner || ""; owner.autocomplete = "off";
  const due = element("input"); due.id = `${id}-due`; due.type = "date"; due.value = item.dueDate || "";
  controls.append(labelled(status, `Status for ${item.help}`, "Status"), labelled(owner, `Owner for ${item.help}`, "Owner"), labelled(due, `Due date for ${item.help}`, "Due"));
  const notesCell = element("td");
  const notes = element("textarea"); notes.id = `${id}-notes`; notes.maxLength = 4000; notes.rows = 2; notes.value = item.notes || "";
  const save = textElement("button", "Save", "button secondary"); save.type = "button";
  save.setAttribute("aria-label", `Save changes for ${item.help}`);
  save.addEventListener("click", () => saveBacklogItem(item, { status: status.value, owner: owner.value, dueDate: due.value, notes: notes.value }));
  notesCell.append(labelled(notes, `Notes for ${item.help}`, "Notes"), save);
  row.append(issue, where, latest, controls, notesCell);
  return row;
}

function labelled(control, accessibleName, visibleText) {
  const label = element("label");
  label.append(textElement("span", visibleText), control);
  control.setAttribute("aria-label", accessibleName);
  return label;
}

async function saveBacklogItem(item, fields) {
  const host = state.backlog?.host;
  const message = $("#remediation-message");
  try {
    const response = await fetch(`/api/backlog/${encodeURIComponent(host)}/items/${encodeURIComponent(item.key)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Save failed.");
    message.textContent = `Saved “${data.help}”.`;
    state.backlog = await fetchJson(`/api/backlog/${encodeURIComponent(host)}`);
    renderBacklogRows();
  } catch (error) {
    message.textContent = `Not saved: ${error.message}`;
  }
}

async function syncBacklogFromReport() {
  const report = state.report;
  const host = safeHostname(report?.targetUrl || "");
  const message = $("#remediation-message");
  try {
    const response = await fetch(`/api/backlog/${encodeURIComponent(host)}/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reportId: report.id }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Update failed.");
    message.textContent = data.alreadySynced ? "This report's findings are already in the backlog." : `Added ${data.added}, reopened ${data.reopened}; ${data.notFound} item(s) were not found in this scan and need verification.`;
    await renderRemediation(report);
  } catch (error) {
    message.textContent = `Backlog not updated: ${error.message}`;
  }
}

async function trackSelectedFinding() {
  const report = state.report;
  const message = $("#track-finding-message");
  try {
    const response = await fetch(`/api/backlog/${encodeURIComponent(safeHostname(report.targetUrl))}/track`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reportId: report.id, findingId: state.selectedIssueId }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not add the finding.");
    message.textContent = "Added to the remediation backlog.";
    void renderRemediation(report);
  } catch (error) {
    message.textContent = error.message;
  }
}

export { renderRemediation, renderBacklogRows, syncBacklogFromReport, trackSelectedFinding };
