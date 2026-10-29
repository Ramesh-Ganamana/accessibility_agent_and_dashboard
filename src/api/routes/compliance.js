import { Router } from "express";
import { readReport } from "../../report/store.js";
import { complianceForReport, importComplianceSet, listComplianceSets, renderComplianceCsv } from "../../report/compliance.js";

export function createComplianceRouter({ baseConfig }) {
  const router = Router();
  // Regulatory checklists: built-in public-source sets plus imported ones (for
  // example a licensed IS 17802 checklist). Decisions are compliance-item reviews.
  router.get("/api/compliance/sets", (request, response, next) => {
    try {
      const catalog = listComplianceSets(baseConfig.reportsDir);
      response.json({ ...catalog, sets: catalog.sets.map(({ items, ...set }) => ({ ...set, items: items.length })) });
    } catch (error) { next(error); }
  });

  router.post("/api/compliance/sets", async (request, response, next) => {
    try { response.status(201).json(await importComplianceSet(baseConfig.reportsDir, request.body)); } catch (error) { next(error); }
  });

  router.get("/api/reports/:id/compliance", async (request, response, next) => {
    try { response.json(complianceForReport(baseConfig.reportsDir, await readReport(baseConfig.reportsDir, request.params.id))); } catch (error) { next(error); }
  });

  router.get("/api/reports/:id/compliance/export.csv", async (request, response, next) => {
    try {
      const compliance = complianceForReport(baseConfig.reportsDir, await readReport(baseConfig.reportsDir, request.params.id));
      response.attachment(`compliance-checklists-${request.params.id}.csv`).type("text/csv").send(`\uFEFF${renderComplianceCsv(compliance)}`);
    } catch (error) { next(error); }
  });
  return router;
}
