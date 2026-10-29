import express from "express";
import path from "node:path";
import { getConfig } from "../config.js";
import { runAccessibilityScan } from "../scanner/crawler.js";
import { runJourney } from "../journeys/runner.js";
import { detectNvdaCapability } from "../assistive-technology/nvda.js";
import { createLocalRequestGuard } from "./middleware/local-request-guard.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createReportsRouter } from "./routes/reports.js";
import { createComplianceRouter } from "./routes/compliance.js";
import { createBacklogRouter } from "./routes/backlog.js";
import { createJourneysRouter } from "./routes/journeys.js";
import { createScansRouter } from "./routes/scans.js";
import { createDocsRouter } from "./routes/docs.js";

/**
 * Assemble the dashboard without opening a port or launching a browser.
 * Each instance owns its job map. Tests can supply runners without invoking NVDA.
 * @param {object} [options]
 * @returns {import("express").Express}
 */
export function createDashboardApp({
  config = getConfig(),
  jobs = new Map(),
  scanRunner = runAccessibilityScan,
  journeyRunner = runJourney,
  nvdaCapability = detectNvdaCapability,
  allowedHosts = process.env.DASHBOARD_ALLOWED_HOSTS || ""
} = {}) {
  const app = express();
  const dependencies = { baseConfig: config, jobs, runAccessibilityScan: scanRunner, runJourney: journeyRunner, detectNvdaCapability: nvdaCapability };
  app.use(createLocalRequestGuard(allowedHosts));
  app.use(express.json({ limit: "1mb" }));
  app.use("/reports", express.static(config.reportsDir));
  app.use(express.static(path.join(config.rootDir, "public")));

  app.use(createDocsRouter(dependencies));
  app.use(createHealthRouter(dependencies));
  // This specific report sub-route must precede /api/reports/:id/:section.
  app.use(createComplianceRouter(dependencies));
  app.use(createReportsRouter(dependencies));
  app.use(createBacklogRouter(dependencies));
  app.use(createJourneysRouter(dependencies));
  app.use(createScansRouter(dependencies));
  app.use(errorHandler);
  return app;
}
