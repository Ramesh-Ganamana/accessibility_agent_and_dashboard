import { Router } from "express";
import { readReport } from "../../report/store.js";
import { backlogHost, readBacklog, renderBacklogCsv, summarizeBacklog, syncBacklog, trackFinding, updateBacklogItem } from "../../report/backlog.js";

export function createBacklogRouter({ baseConfig }) {
  const router = Router();
  // Remediation backlog: one per site, carried across scans.
  router.get("/api/backlog/:host", async (request, response, next) => {
    try {
      const backlog = await readBacklog(baseConfig.reportsDir, request.params.host.toLowerCase());
      response.json({ ...backlog, summary: summarizeBacklog(backlog) });
    } catch (error) { next(error); }
  });

  router.get("/api/backlog/:host/export.csv", async (request, response, next) => {
    try {
      const host = request.params.host.toLowerCase();
      response.attachment(`remediation-backlog-${host}.csv`).type("text/csv").send(renderBacklogCsv(await readBacklog(baseConfig.reportsDir, host)));
    } catch (error) { next(error); }
  });

  router.post("/api/backlog/:host/sync", async (request, response, next) => {
    try {
      const report = await readReport(baseConfig.reportsDir, String(request.body?.reportId || ""));
      if (backlogHost(report.targetUrl) !== request.params.host.toLowerCase()) return response.status(409).json({ error: "That report belongs to a different site." });
      if (report.status !== "complete") return response.status(409).json({ error: "Only a completed scan can update the backlog." });
      response.json(await syncBacklog(baseConfig.reportsDir, report));
    } catch (error) { next(error); }
  });

  router.post("/api/backlog/:host/track", async (request, response, next) => {
    try {
      const report = await readReport(baseConfig.reportsDir, String(request.body?.reportId || ""));
      if (backlogHost(report.targetUrl) !== request.params.host.toLowerCase()) return response.status(409).json({ error: "That report belongs to a different site." });
      response.status(201).json(await trackFinding(baseConfig.reportsDir, report, String(request.body?.findingId || "")));
    } catch (error) { next(error); }
  });

  router.patch("/api/backlog/:host/items/:key", async (request, response, next) => {
    try { response.json(await updateBacklogItem(baseConfig.reportsDir, request.params.host.toLowerCase(), request.params.key, request.body)); }
    catch (error) { next(error); }
  });
  return router;
}
