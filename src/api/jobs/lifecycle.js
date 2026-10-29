import { sanitizeUrlsInText } from "../../url-security.js";

export const STOPPED_PHASE = "Stopped — test browser closed; partial report saved";

// Settles a job from the report a scan or journey resolved with; true means the
// scan completed. Closing the test browser resolves with a "stopped" partial
// report: that is not a failure (no job.error, which tells the user to correct a
// problem), and it must not reach the backlog, where findings missing from a
// partial crawl would be flagged as not found.
export function settleJob(job, report) {
  const at = new Date().toISOString();
  if (report?.status === "stopped") {
    const pages = Array.isArray(report.pages) ? report.pages.length : 0;
    const reason = stopReasonText(report.stopReason);
    const closed = !report.stopReason?.code || report.stopReason.code === "TEST_BROWSER_CLOSED";
    Object.assign(job, { status: "stopped", phase: closed ? STOPPED_PHASE : "Stopped — NVDA interrupted; partial report saved", reportId: report.id || job.reportId, stopReason: reason || "The test browser was closed.", stoppedAt: report.stoppedAt || at, updatedAt: at });
    job.events.push({ at, type: "stopped", message: `${closed ? "Scan stopped because the test browser was closed." : `Scan stopped: ${reason}`} The partial report was saved with ${pages} scanned page${pages === 1 ? "" : "s"}.` });
    if (job.events.length > 80) job.events.shift();
    return false;
  }
  Object.assign(job, { status: "complete", phase: "Complete", progress: 100, reportId: report.id, updatedAt: at });
  return true;
}

function stopReasonText(value) {
  const text = typeof value === "string" ? value : value?.message;
  return text ? sanitizeUrlsInText(String(text)).slice(0, 500) : "";
}

// Tab handling and NVDA pause/resume are routine recoveries, not warnings, so
// they change the phase only and never warningCount or progress.
export function updateJobFromEvent(job, event) {
  job.updatedAt = event.at || new Date().toISOString();
  // An external or closed secondary tab is not what the scan is on.
  if (event.url && !["tab-external", "tab-returned-home"].includes(event.type)) job.currentUrl = event.url;
  const message = String(event.message || "").toLowerCase();

  if (event.type === "report-started" && event.reportId) {
    job.reportId = event.reportId;
  } else if (event.type === "browser-closed") {
    job.phase = "Test browser closed — saving partial report";
  } else if (event.type === "scan-stopped") {
    if (event.reportId) job.reportId = event.reportId;
    job.phase = event.reason === "nvda_interrupted" ? "Stopped — NVDA interrupted; partial report saved" : STOPPED_PHASE;
  } else if (event.type === "nvda-paused") {
    job.phase = "NVDA paused — returning to the test tab";
  } else if (event.type === "nvda-resumed") {
    job.phase = "NVDA resumed — crawl continuing";
  } else if (event.type === "tab-returned-home") {
    job.phase = "New tab handled — back on the home tab";
  } else if (event.type === "tab-external") {
    job.phase = "External tab recorded — not tested";
  } else if (event.type === "session") {
    job.phase = "Authentication";
    if (message.includes("browser started")) { job.phase = "Launching browser"; job.progress = Math.max(job.progress, 5); }
    else if (message.includes("waiting for the login")) job.progress = Math.max(job.progress, 10);
    else if (message.includes("opening the application login")) job.progress = Math.max(job.progress, 14);
    else if (message.includes("username submitted")) job.progress = Math.max(job.progress, 18);
    else if (message.includes("submitting the password")) job.progress = Math.max(job.progress, 23);
    else if (message.includes("login completed")) job.progress = Math.max(job.progress, 30);
  } else if (event.type === "ai-auth") {
    job.phase = "Identifying login controls";
    job.progress = Math.max(job.progress, 12);
  } else if (event.type === "progress") {
    job.phase = "Scanning application";
    job.progress = Math.max(job.progress, Math.min(95, 30 + Math.round((event.current / Math.max(1, event.total)) * 65)));
  } else if (event.type === "actions") {
    job.phase = "Discovering clickable actions";
    job.progress = Math.max(job.progress, 35);
  } else if (event.type === "actions-summary") {
    job.phase = "Interaction coverage recorded";
  } else if (event.type === "crawl-termination") {
    job.phase = event.reason === "completed_with_blocked_branches" ? "Completed with blocked branches"
      : event.reason === "test_browser_closed" ? "Test browser closed — partial coverage"
        : /limit_reached$/.test(event.reason || "") ? "Crawl limit reached — partial coverage" : "Crawl coverage complete";
  } else if (event.type === "nvda") {
    job.phase = "Testing current state with NVDA";
  } else if (event.type === "nvda-complete") {
    job.phase = "NVDA test recorded";
  } else if (event.type === "nvda-warning") {
    job.phase = "NVDA warning — crawl continuing";
    job.warningCount += 1;
  } else if (event.type === "crawl-warning") {
    job.phase = "Crawl warning — continuing";
    job.warningCount += 1;
  } else if (event.type === "state" || event.type === "dialog") {
    job.phase = "Scanning interaction state";
    job.progress = Math.max(job.progress, 38);
  } else if (event.type === "ai") {
    job.phase = "AI review";
  } else if (event.type === "ai-grounding-wait") {
    job.phase = "Waiting for stalled crawl fallback";
  } else if (event.type === "ai-grounding") {
    job.phase = "AI numbered-element navigation";
  } else if (event.type === "blocker-detected" || event.type === "blocker-recovery") {
    job.phase = "Resolving blocking dialog";
    job.progress = Math.max(job.progress, 38);
  } else if (event.type === "blocker-resolved") {
    job.phase = "Blocker resolved — continuing crawl";
  } else if (event.type === "blocker-user-action-required") {
    job.phase = "Blocked branch — user input required";
    job.warningCount += 1;
  } else if (event.type === "post-login") {
    job.phase = "Completing post-login setup";
    job.progress = Math.max(job.progress, 27);
  } else if (event.type === "journey") {
    job.phase = "Running journey step";
    job.progress = Math.min(95, Math.max(job.progress, 10) + 3);
  } else if (event.type === "journey-warning") {
    job.phase = "Journey stopped";
    job.warningCount += 1;
  } else if (event.type === "documents") {
    job.phase = "Checking linked documents";
    job.progress = Math.max(job.progress, 92);
  } else if (event.type === "page-error") {
    job.phase = "Page warning — continuing";
    job.warningCount += 1;
  }
}

export function publicScanError(error) {
  if (error?.code === "LOGIN_FAILED") return sanitizeUrlsInText(error.message);
  // A scan normally resolves as "stopped" when its browser closes; this covers a
  // close that escaped that path, instead of showing a raw Playwright message.
  if (["TEST_BROWSER_CLOSED", "PAGE_CLOSED"].includes(error?.code) || /Target page, context or browser has been closed|Browser has been closed/i.test(error?.message || "")) {
    return "The test browser was closed before the scan finished. Results recorded until then, if any, are in the saved reports list.";
  }
  if (error?.code === "BROWSER_LAUNCH_FAILED" || /spawn EPERM/i.test(error?.message || "")) {
    return "The browser could not start. Set BROWSER_CHANNEL=msedge in .env, restart the server, and try again. If Windows still blocks it, run PowerShell as Administrator once to verify local browser permissions.";
  }
  if (/net::ERR_(?:CERT_|SSL_|BAD_SSL)/i.test(error?.message || "")) {
    return "The site's TLS certificate was rejected. Credentials are never typed into a page with an invalid certificate. For a trusted QA host with a self-signed certificate, set IGNORE_HTTPS_ERRORS=true in .env and restart the server.";
  }
  return sanitizeUrlsInText(String(error?.message || "Scan failed.").split("\nCall log:", 1)[0]);
}
