import { Router } from "express";
import path from "node:path";
import { getConfig } from "../../config.js";
import { listJourneys } from "../../journeys/runner.js";
import { mergeActionExclusions } from "../../browser/action-exclusions.js";
import { updateJobFromEvent, settleJob, publicScanError } from "../jobs/lifecycle.js";

export function createJourneysRouter({ baseConfig, jobs, runJourney }) {
  const router = Router();
  // Scripted journeys live in the journeys/ folder; test data stays local.
  const journeysDir = path.join(baseConfig.rootDir, "journeys");

  router.get("/api/journeys", async (_request, response, next) => {
    try { response.json(await listJourneys(journeysDir)); } catch (error) { next(error); }
  });

  router.post("/api/journeys/run", async (request, response, next) => {
    try {
      const name = String(request.body?.file || "");
      if (!/^[\w.-]+\.json$/.test(name)) return response.status(400).json({ error: "Choose a journey file from the journeys folder." });
      const file = path.join(journeysDir, name);
      const available = await listJourneys(journeysDir);
      const entry = available.find((item) => item.file === name);
      if (!entry) return response.status(404).json({ error: "Journey file not found." });
      if (!entry.valid) return response.status(400).json({ error: entry.error });
      // The dashboard's Do not click entries and EXCLUDE_ACTION_LABELS both apply
      // to the journey's application.
      let excludeActionLabels;
      try { excludeActionLabels = mergeActionExclusions(process.env.EXCLUDE_ACTION_LABELS, request.body?.excludeActionLabels); }
      catch (error) { return response.status(400).json({ error: `${error.message} Entries from EXCLUDE_ACTION_LABELS also count.` }); }
      const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      const job = { id: jobId, status: "running", phase: `Journey: ${entry.name}`, progress: 5, events: [], reportId: null, error: null, currentUrl: null, warningCount: 0, startedAt: now, updatedAt: now };
      jobs.set(jobId, job);
      response.status(202).json(job);
      runJourney({ file, config: getConfig({ targetUrl: entry.startUrl, login: false, excludeActionLabels }), onEvent: (event) => {
        job.events.push(event);
        if (job.events.length > 80) job.events.shift();
        updateJobFromEvent(job, event);
      } }).then((report) => {
        settleJob(job, report);
      }).catch((error) => {
        Object.assign(job, { status: "failed", phase: "Failed", error: publicScanError(error), updatedAt: new Date().toISOString() });
        job.events.push({ at: job.updatedAt, type: "failed", message: job.error });
      });
    } catch (error) { next(error); }
  });
  return router;
}
