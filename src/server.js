import express from "express";
import path from "node:path";
import { getConfig } from "./config.js";
import { runAccessibilityScan } from "./scanner/crawler.js";
import { listReports, readReport } from "./report/store.js";
import { compareReports } from "./report/comparison.js";
import { reportSection } from "./report/assessment.js";

const baseConfig = getConfig();
const app = express();
const jobs = new Map();

app.use(express.json({ limit: "1mb" }));
app.use("/reports", express.static(baseConfig.reportsDir));
app.use(express.static(path.join(baseConfig.rootDir, "public")));

app.get("/api/health", (_request, response) => response.json({
  ok: true,
  service: "AI Accessibility Automation Agent",
  build: "accessibility-health-dashboard-40",
  browserChannel: baseConfig.browserChannel,
  aiLoginAvailable: Boolean(baseConfig.openAiApiKey)
}));

app.get("/api/reports", async (_request, response, next) => {
  try { response.json(await listReports(baseConfig.reportsDir)); } catch (error) { next(error); }
});

app.get("/api/reports/:id", async (request, response, next) => {
  try { response.json(await readReport(baseConfig.reportsDir, request.params.id)); } catch (error) { next(error); }
});

app.get("/api/reports/:id/compare/:previousId", async (request, response, next) => {
  try {
    const [current, previous] = await Promise.all([
      readReport(baseConfig.reportsDir, request.params.id),
      readReport(baseConfig.reportsDir, request.params.previousId)
    ]);
    response.json(compareReports(current, previous));
  } catch (error) { next(error); }
});

app.get("/api/reports/:id/:section", async (request, response, next) => {
  try {
    const allowed = new Set(["overview", "score", "issues", "pages", "graph", "activity", "acr", "evidence"]);
    if (!allowed.has(request.params.section)) return response.status(404).json({ error: "Unknown report section." });
    const report = await readReport(baseConfig.reportsDir, request.params.id);
    response.json(reportSection(report, request.params.section));
  } catch (error) { next(error); }
});

app.get("/api/jobs/:id", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: "Job not found." });
  response.json(job);
});

app.post("/api/scans", async (request, response) => {
  const { targetUrl, maxPages, maxDepth, aiEnabled, auth, excludeActionLabels } = request.body || {};
  try {
    const parsed = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    return response.status(400).json({ error: "Enter a valid http or https URL." });
  }

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

  const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const job = { id: jobId, status: "queued", phase: "Queued", progress: 0, events: [], reportId: null, error: null, currentUrl: null, warningCount: 0, startedAt: now, updatedAt: now };
  jobs.set(jobId, job);
  response.status(202).json(job);

  const config = getConfig({
    targetUrl,
    maxPages: Math.min(Math.max(Number(maxPages) || 10, 1), 100),
    maxDepth: Math.min(Math.max(Number(maxDepth) || 2, 0), 8),
    aiEnabled: Boolean(aiEnabled) && Boolean(baseConfig.openAiApiKey),
    excludeActionLabels: parseActionLabels(excludeActionLabels),
    excludeActionOrigin: new URL(targetUrl).origin,
    login
  });

  if (request.body?.auth) request.body.auth.password = "";

  job.status = "running";
  job.phase = "Launching browser";
  job.progress = 2;
  runAccessibilityScan(config, (event) => {
    job.events.push(event);
    if (job.events.length > 80) job.events.shift();
    updateJobFromEvent(job, event);
  }).then((report) => {
    job.status = "complete";
    job.phase = "Complete";
    job.progress = 100;
    job.reportId = report.id;
    job.updatedAt = new Date().toISOString();
  }).catch((error) => {
    job.status = "failed";
    job.phase = "Failed";
    job.error = publicScanError(error);
    job.updatedAt = new Date().toISOString();
    job.events.push({ at: job.updatedAt, type: "failed", message: job.error });
  });
});

function updateJobFromEvent(job, event) {
  job.updatedAt = event.at || new Date().toISOString();
  if (event.url) job.currentUrl = event.url;
  const message = String(event.message || "").toLowerCase();

  if (event.type === "session") {
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
  } else if (event.type === "post-login") {
    job.phase = "Completing post-login setup";
    job.progress = Math.max(job.progress, 27);
  } else if (event.type === "page-error") {
    job.phase = "Page warning — continuing";
    job.warningCount += 1;
  }
}

function publicScanError(error) {
  if (error?.code === "LOGIN_FAILED") return error.message;
  if (error?.code === "BROWSER_LAUNCH_FAILED" || /spawn EPERM/i.test(error?.message || "")) {
    return "The browser could not start. Set BROWSER_CHANNEL=msedge in .env, restart the server, and try again. If Windows still blocks it, run PowerShell as Administrator once to verify local browser permissions.";
  }
  return String(error?.message || "Scan failed.").split("\nCall log:", 1)[0];
}

function selectorOrDefault(value, fallback) {
  const selector = String(value || "").trim();
  return selector ? selector.slice(0, 1_000) : fallback;
}

function parseActionLabels(value) {
  return (Array.isArray(value) ? value : String(value || "").split(/[\n,]/))
    .map((item) => String(item).replace(/\s+/g, " ").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 100);
}

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || (error.code === "ENOENT" ? 404 : 500)).json({ error: error.message || "Unexpected server error." });
});

app.listen(baseConfig.port, "127.0.0.1", () => {
  console.log(`Accessibility Agent dashboard: http://localhost:${baseConfig.port}`);
});
