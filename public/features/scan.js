import { $, element, textElement, truncate, capitalize, stopReasonText, formatElapsed, formatTime, fetchJson } from "../shared/ui.js";
import { state } from "../state.js";

export function createScanController({ renderReport, loadHistory, fetchReportWithAssessment }) {
  async function startScan(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const authEnabled = form.has("authEnabled");
    const payload = {
      targetUrl: form.get("targetUrl"),
      maxPages: Number(form.get("maxPages")),
      maxStates: Number(form.get("maxStates")),
      maxDepth: Number(form.get("maxDepth")),
      aiEnabled: form.has("aiEnabled"),
      screenReaders: { nvda: form.has("nvdaEnabled") },
      audit: { profile: form.get("auditProfile"), wcagVersion: form.get("wcagVersion"), level: "AA" },
      device: form.get("device") === "mobile" ? "mobile" : "desktop",
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
    state.lastJob = null;
    state.lastJobAnnouncement = "";
    renderJobStatus({ status: "running", phase: "Checking scanner connection", progress: 0, startedAt: new Date().toISOString(), events: [{ at: new Date().toISOString(), type: "session", message: "Checking the local backend before sending scan or login data." }] });
    let requestAttempted = false;
    let requestRejected = false;
    try {
      await checkScanBackend();
      requestAttempted = true;
      const request = fetch("/api/scans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      $("#login-password").value = "";
      const response = await request;
      requestRejected = !response.ok;
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || "Could not start scan.");
      if (!job?.id) throw new Error("The backend did not return a scan identifier.");
      pollJob(job.id, submit);
    } catch (error) {
      const unknownStart = requestAttempted && !requestRejected;
      const message = unknownStart
        ? "The scan request lost its connection before a scan identifier was received. The scan may have started; check the npm start terminal and saved reports before retrying. This is not a login-locator error."
        : error.message;
      renderJobStatus({ status: "failed", phase: error.code === "BACKEND_UNAVAILABLE" ? "Scanner backend disconnected" : unknownStart ? "Scan start could not be confirmed" : "Could not start scan", progress: 0, error: message,
        connectionMessage: error.code === "BACKEND_UNAVAILABLE" ? "No scan request or credentials were sent. Keep npm start running, then press Start scan again. Advanced login selectors are optional."
          : unknownStart ? "Do not automatically resubmit: that could launch a duplicate scan. Check the backend terminal first." : null,
        events: [{ at: new Date().toISOString(), type: "failed", message }] });
      submit.disabled = false;
    } finally {
      // Credentials are needed only to construct the request, never for status polling.
      if (payload.auth) payload.auth.password = "";
    }
  }

  async function checkScanBackend() {
    try {
      const response = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Backend health check failed.");
      const health = await response.json();
      if (!health || typeof health !== "object" || health.ok === false) throw new Error("Backend health check failed.");
    } catch {
      const error = new Error("Cannot reach the local scanner backend. Run npm start in the project folder and keep that terminal open. Open the dashboard at the localhost address printed there. Automatic login discovery has not started yet.");
      error.code = "BACKEND_UNAVAILABLE";
      throw error;
    }
  }

  async function pollJob(jobId, submit, failures = 0) {
    clearTimeout(state.jobTimer);
    let responseStatus = 0;
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(15000) });
      responseStatus = response.status;
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || "Could not read scan status.");
      state.lastJob = job;
      renderJobStatus(job);
      if (job.status === "complete") {
        const { report, assessment } = await fetchReportWithAssessment(job.reportId);
        renderReport(report, assessment); await loadHistory(); submit.disabled = false;
        document.querySelector(".report-shell").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (job.status === "failed") { submit.disabled = false; return; }
      // Closing the test browser ends the scan with a saved partial report.
      if (job.status === "stopped") {
        if (job.reportId) {
          const { report, assessment } = await fetchReportWithAssessment(job.reportId);
          renderReport(report, assessment); await loadHistory();
          document.querySelector(".report-shell").scrollIntoView({ behavior: "smooth", block: "start" });
        }
        submit.disabled = false;
        return;
      }
      state.jobTimer = setTimeout(() => pollJob(jobId, submit), 1000);
    } catch (error) {
      const missingJob = responseStatus === 404;
      const stopped = state.lastJob?.status === "stopped";
      const completed = stopped || state.lastJob?.status === "complete";
      const delay = Math.min(10000, 1500 * 2 ** Math.min(failures, 3));
      const message = missingJob
        ? "The server no longer has this scan status. Check saved reports before starting another scan."
        : stopped ? "The scan stopped, but its partial report could not be loaded. Retrying automatically."
          : completed ? "The scan completed, but its report could not be loaded. Retrying automatically."
            : "The status connection was interrupted. The scan may still be running; reconnecting automatically.";
      renderJobStatus({ ...state.lastJob, status: "connection-lost", phase: missingJob ? "Scan status unavailable" : stopped ? "Loading partial report" : completed ? "Loading completed report" : "Reconnecting to scan", connectionMessage: message,
        events: [...(state.lastJob?.events || []), { at: new Date().toISOString(), type: "connection-warning", message: `${message} ${error.message}` }] });
      if (missingJob) submit.disabled = false;
      else state.jobTimer = setTimeout(() => pollJob(jobId, submit, failures + 1), delay);
    }
  }

  function renderJobStatus(job) {
    const panel = $("#job-progress");
    const events = job.events || [];
    const lastEvent = events.at(-1);
    const hasWarning = ["page-error", "crawl-warning", "blocker-user-action-required"].includes(lastEvent?.type);
    const waiting = /waiting|loading|authentication|identifying/i.test(`${job.phase || ""} ${lastEvent?.message || ""}`);
    const visualState = job.status === "failed" ? "failed" : job.status === "complete" ? "complete" : job.status === "stopped" ? "stopped" : job.status === "connection-lost" ? "warning" : hasWarning ? "warning" : waiting ? "waiting" : "running";
    const percent = Math.max(0, Math.min(100, Number(job.progress || 0)));
    const icons = { running: "●", waiting: "◌", warning: "!", failed: "×", complete: "✓", stopped: "■" };
    const labels = { running: job.phase || "Working", waiting: job.phase || "Waiting", warning: job.status === "connection-lost" ? job.phase : "Warning — scan continuing", failed: job.phase || "Scan failed", complete: "Scan complete", stopped: "Scan stopped — partial report saved" };
    const elapsed = job.startedAt ? formatElapsed(Date.now() - Date.parse(job.startedAt)) : null;
    const context = [elapsed ? `Elapsed ${elapsed}` : null, job.currentUrl ? truncate(job.currentUrl, 90) : null, job.warningCount ? `${job.warningCount} warning${job.warningCount === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");

    panel.hidden = false;
    panel.className = `job-progress ${visualState}`;
    // Announce a phase or outcome once when it changes; never the per-second
    // elapsed time or the rolling step list.
    // A stop follows the user's own action (closing the browser), so it is
    // announced politely rather than as an alert.
    const announcement = visualState === "failed" ? `Scan failed. ${job.error || ""}`.trim()
      : visualState === "complete" ? "Scan complete."
        : visualState === "stopped" ? `Scan stopped: ${(stopReasonText(job.stopReason) || "the test browser was closed").replace(/[.!]+$/, "")}. The partial report was saved.` : labels[visualState];
    if (announcement && announcement !== state.lastJobAnnouncement) {
      state.lastJobAnnouncement = announcement;
      $(visualState === "failed" ? "#job-alert" : "#job-announcer").textContent = announcement;
    }
    $("#job-status-icon").textContent = icons[visualState];
    $("#job-status-label").textContent = labels[visualState];
    $("#job-message").textContent = job.error || lastEvent?.message || capitalize(job.status || "running");
    $("#job-detail").textContent = job.connectionMessage || (job.error ? `The scan stopped. Correct the problem and press Start scan to retry.${context ? ` ${context}` : ""}`
      : visualState === "stopped" ? `${job.reportId ? "Results recorded before the scan stopped are in the report below." : "No partial report was recorded."} Press Start scan to run a new scan.${context ? ` ${context}` : ""}`
        : context || "The scanner is working. New steps will appear below.");
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

  async function loadJourneys() {
    const select = $("#journey-file");
    try {
      const journeys = await fetchJson("/api/journeys");
      select.replaceChildren();
      if (!journeys.length) select.append(new Option("No journey files found", ""));
      for (const journey of journeys) {
        const option = new Option(journey.valid ? `${journey.name} · ${journey.environment} · ${journey.steps} steps` : `${journey.file} (invalid)`, journey.file);
        option.disabled = !journey.valid;
        option.title = journey.valid ? journey.startUrl : journey.error;
        select.append(option);
      }
      $("#journey-run").disabled = !journeys.some((journey) => journey.valid);
    } catch (error) {
      $("#journey-message").textContent = `Journeys could not be listed: ${error.message}`;
    }
  }

  async function runSelectedJourney() {
    const file = $("#journey-file").value;
    const button = $("#journey-run");
    if (!file) return;
    button.disabled = true;
    state.lastJob = null;
    state.lastJobAnnouncement = "";
    try {
      // The Do not click entries typed above also apply to the journey.
      const response = await fetch("/api/journeys/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, excludeActionLabels: $("#exclude-action-labels").value }) });
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || "The journey could not start.");
      $("#journey-message").textContent = "Journey started. Progress appears in the scan status panel.";
      renderJobStatus(job);
      pollJob(job.id, button);
    } catch (error) {
      $("#journey-message").textContent = error.message;
      button.disabled = false;
    }
  }
  return { startScan, loadJourneys, runSelectedJourney };
}
