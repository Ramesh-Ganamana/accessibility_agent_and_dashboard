import { Router } from "express";
import { listReports, readReport, appendAuditReview, readVpatProfile, saveVpatProfile } from "../../report/store.js";
import { buildVpat, renderVpatDocx, renderVpatHtml, VPAT_EDITIONS } from "../../report/vpat.js";
import { renderAcrHtml, renderAcrCsv } from "../../report/export.js";
import { compareReports } from "../../report/comparison.js";
import { reportSection } from "../../report/assessment.js";

export function createReportsRouter({ baseConfig, jobs }) {
  const router = Router();
  // A report saved as in-progress with no running job was cut off by a crash or restart.
  // A "stopped" report (test browser closed, partial results saved) passes through.
  function withRuntimeStatus(report) {
    if (report?.status !== "in-progress") return report;
    const running = [...jobs.values()].some((job) => job.reportId === report.id && ["queued", "running"].includes(job.status));
    return running ? report : { ...report, status: "interrupted" };
  }
  router.get("/api/reports", async (_request, response, next) => {
    try { response.json((await listReports(baseConfig.reportsDir)).map(withRuntimeStatus)); } catch (error) { next(error); }
  });

  router.get("/api/reports/:id", async (request, response, next) => {
    try { response.json(withRuntimeStatus(await readReport(baseConfig.reportsDir, request.params.id))); } catch (error) { next(error); }
  });

  router.post("/api/reports/:id/reviews", async (request, response, next) => {
    try { response.status(201).json(await appendAuditReview(baseConfig.reportsDir, request.params.id, request.body)); }
    catch (error) { next(error); }
  });

  router.get("/api/reports/:id/exports/:format", async (request, response, next) => {
    try {
      const report = await readReport(baseConfig.reportsDir, request.params.id);
      const format = request.params.format;
      if (!["json", "csv", "html"].includes(format)) return response.status(404).json({ error: "Unknown export format." });
      response.attachment(`accessibility-draft-${request.params.id}.${format}`);
      if (format === "json") return response.type("json").send(JSON.stringify(report, null, 2));
      response.type(format === "html" ? "html" : "text/csv").send(format === "html" ? renderAcrHtml(report) : renderAcrCsv(report));
    } catch (error) { next(error); }
  });

  router.get("/api/reports/:id/compare/:previousId", async (request, response, next) => {
    try {
      const [current, previous] = await Promise.all([
        readReport(baseConfig.reportsDir, request.params.id),
        readReport(baseConfig.reportsDir, request.params.previousId)
      ]);
      response.json(compareReports(current, previous));
    } catch (error) { next(error); }
  });

  router.get("/api/reports/:id/vpat-profile", async (request, response, next) => {
    try { response.json(await readVpatProfile(baseConfig.reportsDir, request.params.id)); } catch (error) { next(error); }
  });

  router.post("/api/reports/:id/vpat-profile", async (request, response, next) => {
    try { response.json(await saveVpatProfile(baseConfig.reportsDir, request.params.id, request.body)); } catch (error) { next(error); }
  });
  // VPAT 2.5-structured ACR: edition wcag | 508 | eu | int, format html | docx.
  router.get("/api/reports/:id/vpat/:edition/:format", async (request, response, next) => {
    try {
      const { edition, format } = request.params;
      if (!VPAT_EDITIONS[edition] || !["html", "docx"].includes(format)) return response.status(404).json({ error: "Unknown VPAT edition or format." });
      const report = await readReport(baseConfig.reportsDir, request.params.id);
      const model = buildVpat(report, await readVpatProfile(baseConfig.reportsDir, request.params.id), edition);
      const name = `VPAT-2.5-${VPAT_EDITIONS[edition].label.replace(/\s+/g, "-")}-${request.params.id}${model.readiness.final ? "" : "-DRAFT"}.${format}`;
      response.attachment(name);
      if (format === "html") return response.type("html").send(renderVpatHtml(model));
      response.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(await renderVpatDocx(model));
    } catch (error) { next(error); }
  });

  router.get("/api/reports/:id/:section", async (request, response, next) => {
    try {
      const allowed = new Set(["overview", "score", "issues", "pages", "graph", "activity", "acr", "audit", "financial", "reviews", "evidence", "assistive-technology"]);
      if (!allowed.has(request.params.section)) return response.status(404).json({ error: "Unknown report section." });
      const report = await readReport(baseConfig.reportsDir, request.params.id);
      if (request.params.section === "audit") return response.json(report.audit);
      if (request.params.section === "financial") return response.json(report.audit.financial);
      if (request.params.section === "reviews") return response.json(report.auditReviews);
      response.json(reportSection(report, request.params.section));
    } catch (error) { next(error); }
  });
  return router;
}
