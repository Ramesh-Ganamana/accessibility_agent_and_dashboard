import { Router } from "express";
import { getConfig } from "../../config.js";
import { scanRequestError } from "../../scan-request.js";
import { mergeActionExclusions } from "../../browser/action-exclusions.js";
import { sanitizeUrlsInText } from "../../url-security.js";
import { syncBacklog } from "../../report/backlog.js";
import { updateJobFromEvent, settleJob, publicScanError } from "../jobs/lifecycle.js";

export function createScansRouter({ baseConfig, jobs, runAccessibilityScan }) {
  const router = Router();
  const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

  router.get("/api/jobs/:id", (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) return response.status(404).json({ error: "Job not found." });
    response.json(job);
  });

  router.post("/api/scans", async (request, response) => {
    const invalidRequest = scanRequestError(request.body);
    if (invalidRequest) return response.status(400).json({ error: invalidRequest });
    const { targetUrl, maxPages, maxStates, maxDepth, aiEnabled, auth, excludeActionLabels, screenReaders, audit, device } = request.body || {};
    try {
      const parsed = new URL(targetUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    } catch {
      return response.status(400).json({ error: "Enter a valid http or https URL." });
    }
    // EXCLUDE_ACTION_LABELS from the server settings and the dashboard entries
    // both apply; an empty dashboard field never drops the configured list.
    let excludedActions;
    try { excludedActions = mergeActionExclusions(process.env.EXCLUDE_ACTION_LABELS, excludeActionLabels); }
    catch (error) { return response.status(400).json({ error: `${error.message} Entries from EXCLUDE_ACTION_LABELS also count.` }); }

    let login = false;
    if (auth?.enabled) {
      try {
        const loginUrl = new URL(auth.loginUrl);
        if (!["http:", "https:"].includes(loginUrl.protocol)) throw new Error();
      } catch {
        return response.status(400).json({ error: "Enter a valid login-page URL." });
      }
      if (!String(auth.username || "").trim() || !String(auth.password || "")) {
        return response.status(400).json({ error: "Username and password are required when website login is enabled." });
      }
      login = {
        url: String(auth.loginUrl).slice(0, 2_048),
        username: String(auth.username).slice(0, 512),
        password: String(auth.password).slice(0, 2_048),
        persist: auth.persist !== false,
        aiEnabled: Boolean(auth.aiEnabled) && Boolean(baseConfig.openAiApiKey),
        postLoginValue: String(auth.postLoginValue || "").trim().slice(0, 256),
        emailSelector: selectorOrDefault(auth.emailSelector, '#signInName, input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]'),
        passwordSelector: selectorOrDefault(auth.passwordSelector, 'input[type="password"], input[autocomplete="current-password"]'),
        submitSelector: selectorOrDefault(auth.submitSelector, '#continue, #next, #signIn, button[type="submit"], input[type="submit"]')
      };
    }

    const config = getConfig({
      targetUrl,
      maxPages: maxPages ?? 10,
      maxStates,
      maxDepth: maxDepth ?? 2,
      aiEnabled: Boolean(aiEnabled) && Boolean(baseConfig.openAiApiKey),
      excludeActionLabels: excludedActions,
      excludeActionOrigin: new URL(targetUrl).origin,
      nvda: { requested: Boolean(screenReaders?.nvda) },
      device: device === "mobile" ? "mobile" : "desktop",
      audit,
      login
    });

    if (request.body?.auth) request.body.auth.password = "";

    for (const [id, existing] of jobs) {
      if (!["queued", "running"].includes(existing.status) && Date.now() - Date.parse(existing.updatedAt) > JOB_RETENTION_MS) jobs.delete(id);
    }
    const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const job = { id: jobId, status: "queued", phase: "Queued", progress: 0, events: [], reportId: null, error: null, currentUrl: null, warningCount: 0, startedAt: now, updatedAt: now };
    jobs.set(jobId, job);
    response.status(202).json(job);

    job.status = "running";
    job.phase = "Launching browser";
    job.progress = 2;
    runAccessibilityScan(config, (event) => {
      job.events.push(event);
      if (job.events.length > 80) job.events.shift();
      updateJobFromEvent(job, event);
    }).then((report) => {
      // A failed backlog update must never turn a completed scan into a failure.
      if (settleJob(job, report)) syncBacklog(baseConfig.reportsDir, report).catch((error) => console.error(`Backlog update skipped: ${sanitizeUrlsInText(error.message)}`));
    }).catch((error) => {
      job.status = "failed";
      job.phase = "Failed";
      job.error = publicScanError(error);
      job.updatedAt = new Date().toISOString();
      job.events.push({ at: job.updatedAt, type: "failed", message: job.error });
    });
  });

  function selectorOrDefault(value, fallback) {
    const selector = String(value || "").trim();
    return selector ? selector.slice(0, 1_000) : fallback;
  }
  return router;
}
