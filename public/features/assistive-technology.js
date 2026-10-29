import { $, element, textElement, sum, capitalize, shortPath, formatTime, productStatus } from "../shared/ui.js";
import { state } from "../state.js";

function renderAssistiveTechnology(report) {
  const metadata = report.assistiveTechnology || {};
  const products = metadata.actualScreenReaders || {};
  $("#assistive-disclaimer").textContent = metadata.disclaimer || "No actual screen-reader execution was recorded for this report.";
  $("#assistive-mode").textContent = metadata.automatedLabel || "Browser tree inspection";
  $("#at-nvda").textContent = productStatus(products.NVDA);
  $("#at-jaws").textContent = productStatus(products.JAWS);
  $("#at-voiceover").textContent = productStatus(products.VoiceOver);
  $("#at-talkback").textContent = productStatus(products.TalkBack);
  renderNvdaRun(metadata.actualRuns?.NVDA, report);

  const states = (report.pages || []).flatMap((page) => page.screenReaderStates || []);
  const warningCount = states.reduce((sum, entry) => sum + (entry.warnings?.length || 0), 0);
  $("#assistive-state-count").textContent = states.length;
  $("#assistive-warning-count").textContent = warningCount;
  const select = $("#assistive-state-select");
  select.replaceChildren();
  if (!states.length) {
    const option = element("option"); option.textContent = "No accessibility-tree capture in this report"; option.value = "";
    select.append(option); select.disabled = true;
    renderAssistiveState(null);
    return;
  }
  select.disabled = false;
  states.forEach((entry, index) => {
    const option = element("option"); option.value = String(index);
    option.textContent = `${shortPath(entry.pageUrl)} · ${entry.state || "default"}${entry.frameUrl !== entry.pageUrl ? " · embedded frame" : ""}`;
    select.append(option);
  });
  select.onchange = () => renderAssistiveState(states[Number(select.value)] || states[0]);
  renderAssistiveState(states[0]);
}

function renderAssistiveState(snapshot) {
  const warnings = $("#assistive-warning-list"); warnings.replaceChildren();
  const announcements = $("#assistive-announcement-list"); announcements.replaceChildren();
  if (!snapshot) {
    $("#assistive-state-title").textContent = "No browser accessibility tree was captured";
    warnings.append(textElement("li", "Run a new scan to create screen-reader-readiness data."));
    announcements.append(textElement("li", "No announcement preview available."));
    return;
  }
  $("#assistive-state-title").textContent = `${shortPath(snapshot.pageUrl)} · ${snapshot.state || "default"}`;
  for (const warning of snapshot.warnings || []) warnings.append(textElement("li", warning));
  if (!snapshot.warnings?.length) warnings.append(textElement("li", "No structural accessibility-tree warning was produced for this observed state. Manual screen-reader testing is still required."));
  for (const item of snapshot.announcementPreview || []) {
    const row = element("li");
    row.append(
      textElement("span", item.role || "node", "assistive-role"),
      textElement("strong", item.name || "Unnamed"),
      textElement("small", [item.value, item.description, ...(item.states || [])].filter(Boolean).join(" · ") || "No additional exposed value or state")
    );
    announcements.append(row);
  }
  if (!snapshot.announcementPreview?.length) announcements.append(textElement("li", "No relevant named roles were exposed in this state."));
}
function renderNvdaRun(run, report) {
  const panel = $("#nvda-run-panel");
  if (!run) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const coverage = run.coverage || {};
  const hasStates = Array.isArray(run.states);
  const legacyPages = !hasStates && Array.isArray(run.pages);
  const entries = hasStates ? run.states : (run.pages || []);
  const afterCrawl = run.executionMode === "after-crawl";
  const live = run.executionMode === "live-during-crawl" || entries.some((entry) => entry.executionMode === "live-during-crawl");
  const interrupted = run.status === "interrupted" || run.outcome === "interrupted" || run.outcome === "partially-tested";
  $("#nvda-run-title").textContent = afterCrawl ? "NVDA after the crawl" : live ? "NVDA during the headed crawl" : "NVDA keyboard-focus test";
  $("#nvda-run-outcome").textContent = productStatus(run.outcome || run.status);
  $("#nvda-run-version").textContent = run.version || "Unavailable";
  $("#nvda-run-states").textContent = legacyPages ? "Not recorded" : `${coverage.statesExecuted || 0} / ${coverage.statesAttempted || 0}`;
  $("#nvda-run-commands").textContent = coverage.keyboardCommands || 0;
  $("#nvda-run-announcements").textContent = coverage.announcementsCaptured || 0;
  $("#nvda-run-summary").textContent = [
    legacyPages ? "Legacy page-only run. Interaction-state coverage was not recorded." : "",
    interrupted
      ? `NVDA started, but testing was interrupted. ${run.reason || "The testing scope could not be recovered."} Available partial evidence is retained below; uncompleted checks are not passes.`
      : run.actualExecution
      ? `NVDA ran in a visible Windows browser${live ? " during crawling" : " after crawling (historical replay mode)"}. Select a ${legacyPages ? "legacy page" : "state"} to review its keyboard actions and locally captured announcements. Recorded execution is not proof of conformance.`
      : `NVDA was requested but not executed. ${run.reason || "Review the configuration notes below."}`,
    run.actualExecution && run.stoppedReason ? `NVDA stopped before finishing${run.stopKind ? ` (${String(run.stopKind).replace(/[_-]+/g, " ")})` : ""}: ${run.stoppedReason}` : ""
  ].filter(Boolean).join(" ");

  const notes = $("#nvda-run-notes"); notes.replaceChildren();
  if (legacyPages) {
    notes.append(textElement("li", `Legacy page-only run: ${coverage.pagesExecuted || 0} of ${coverage.pagesAttempted || 0} pages executed. Menus, dialogs, and other changed states were not separately tested by this run.`));
  } else if (hasStates) {
    notes.append(textElement("li", `${coverage.statesExecuted || 0} states tested of ${coverage.statesAttempted || 0} attempted; ${coverage.statesSelected || 0} selected from ${coverage.statesDiscovered || 0} discovered states.`));
    if (coverage.statesSkippedByLimit) notes.append(textElement("li", `${coverage.statesSkippedByLimit} ${coverage.statesSkippedByLimit === 1 ? "state was" : "states were"} not selected because the NVDA state limit was reached.`));
    if (coverage.statesInterrupted) notes.append(textElement("li", `${coverage.statesInterrupted} state(s) were interrupted. Their available evidence is retained, but remaining checks were not completed.`));
  }
  const pauses = Array.isArray(run.pauses) ? run.pauses : [];
  if (Number.isInteger(coverage.readingCompleted)) {
    notes.append(textElement("li", `Read-to-end checks: ${coverage.readingCompleted} completed with audio confirmation; ${coverage.readingIncomplete || 0} incomplete or unconfirmed. These counts cover available browse content in tested states, not the entire website.`));
  }
  if (pauses.length || run.recoveries) {
    const when = (value) => value && Number.isFinite(new Date(value).getTime()) ? formatTime(value) : "an unrecorded time";
    const resumed = pauses.filter((pause) => pause.resumedAt).length;
    notes.append(textElement("li", `NVDA paused ${pauses.length} ${pauses.length === 1 ? "time" : "times"} when focus left the test tab and resumed ${resumed}; ${run.recoveries || 0} unexpected ${run.recoveries === 1 ? "recovery" : "recoveries"} used.`));
    for (const [index, pause] of pauses.slice(0, 5).entries()) {
      notes.append(textElement("li", `Pause ${index + 1} at ${when(pause.at)}: ${pause.reason || "focus left the test tab"}${pause.detail ? ` (${pause.detail})` : ""} · ${pause.resumedAt ? `resumed at ${when(pause.resumedAt)}` : productStatus(pause.outcome || "not-resumed")}`));
    }
    if (pauses.length > 5) notes.append(textElement("li", `${pauses.length - 5} more ${pauses.length === 6 ? "pause is" : "pauses are"} recorded in the JSON export.`));
  }
  // The stop reason is already in the summary; stop() also files it as a warning.
  for (const note of [...(run.warnings || []), ...(run.limitations || [])]) if (!(run.actualExecution && note === run.stoppedReason)) notes.append(textElement("li", note));
  if (!notes.children.length) notes.append(textElement("li", "No runner warning was recorded. Human NVDA task testing is still required."));

  $("#nvda-state-picker-label").textContent = legacyPages ? "Legacy tested page" : "Tested state";
  const select = $("#nvda-state-select"); select.replaceChildren(); select.onchange = null;
  if (!entries.length) {
    const option = element("option"); option.textContent = legacyPages ? "No legacy NVDA page result" : "No NVDA state result"; option.value = ""; select.append(option); select.disabled = true;
    renderNvdaState(null, report);
    return;
  }
  select.disabled = false;
  entries.forEach((entry, index) => {
    const option = element("option"); option.value = String(index);
    option.textContent = [shortPath(entry.url), legacyPages ? "Legacy page-only" : (entry.state || "default"), legacyPages ? "" : entry.stateId, productStatus(entry.status)].filter(Boolean).join(" · ");
    select.append(option);
  });
  select.onchange = () => renderNvdaState(entries[Number(select.value)] || entries[0], report, legacyPages);
  renderNvdaState(entries[0], report, legacyPages);
}

function renderNvdaState(entry, report, legacyPage = false) {
  const transcript = $("#nvda-transcript-list"); transcript.replaceChildren();
  const evidence = $("#nvda-run-evidence"); evidence.replaceChildren();
  const checks = $("#nvda-checks"); checks.replaceChildren();
  if (!entry) {
    transcript.append(textElement("li", "No actual NVDA transcript was captured."));
    return;
  }
  for (const [name, check] of Object.entries(entry.checks || {})) {
    const card = element("div");
    card.append(textElement("strong", name === "requiredFields" ? "Required fields" : capitalize(name)), textElement("span", productStatus(check.status)), textElement("small", check.reason || `${check.commands || 0} commands recorded`));
    checks.append(card);
  }
  for (const action of entry.actions || []) {
    const row = element("li");
    row.append(
      textElement("span", `${action.index}. ${action.command}`, "nvda-command"),
      textElement("strong", action.announcements?.join(" · ") || "No announcement captured"),
      textElement("small", [action.focus?.tag, action.focus?.role, action.focus?.name].filter(Boolean).join(" · ") || "Focused element unavailable")
    );
    if (action.stateChanged) row.append(textElement("small", "This command changed the captured state; review the transition."));
    if (action.outcome) row.append(textElement("small", `Observation: ${productStatus(action.outcome)}`));
    if (action.requiredFieldCheck) {
      const check = action.requiredFieldCheck;
      row.append(textElement("small", `Required-field check: ${productStatus(check.status)}. ${check.reason || "Review the captured announcement."}`, "nvda-required-field-check"));
      row.append(textElement("small", `Detected indicators: ${(check.sources || []).join(" · ") || "Unknown"}`));
    }
    if (action.readingCompletion) row.append(textElement("small", `Reading: ${productStatus(action.readingCompletion)}. ${action.reason || "Review the transcript and coverage."}`));
    transcript.append(row);
  }
  if (entry.error) transcript.append(textElement("li", entry.error));
  if (!transcript.children.length) transcript.append(textElement("li", `No keyboard actions were completed in this ${legacyPage ? "legacy page" : "state"}.`));
  const screenshots = [...new Map([{ path: entry.evidence, label: "Open headed-browser evidence screenshot" }, ...(entry.actions || []).map((action) => ({ path: action.evidence, label: `${action.index}. ${action.command} — screenshot` }))].filter((item) => item.path).map((item) => [item.path, item])).values()];
  for (const screenshot of screenshots) {
    if (!/^evidence\/nvda\/[a-zA-Z0-9._-]+\.png$/i.test(screenshot.path) || !/^[a-zA-Z0-9_-]+$/.test(report.id || "") || report.id === "demo") continue;
    const link = element("a", "nvda-evidence-link");
    link.href = `/reports/${encodeURIComponent(report.id)}/${screenshot.path.split("/").map(encodeURIComponent).join("/")}`;
    link.target = "_blank"; link.rel = "noreferrer"; link.textContent = screenshot.label;
    evidence.append(link);
    const preview = element("img", "nvda-evidence-preview"); preview.src = link.href; preview.alt = screenshot.label; preview.loading = "lazy";
    preview.addEventListener("error", () => { preview.remove(); link.after(textElement("small", "Screenshot could not be loaded. Check that the local server and saved evidence are available.")); }, { once: true });
    evidence.append(preview);
  }
  if (!evidence.children.length) evidence.append(textElement("p", "No screenshot was saved for this state.", "form-note"));
}

export { renderAssistiveTechnology, renderNvdaRun };
