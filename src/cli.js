import { existsSync } from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";
import { runAccessibilityScan } from "./scanner/crawler.js";

const args = process.argv.slice(2);
// AI checks send screenshots and page metadata to OpenAI, so they run only when
// explicitly requested with --ai (or AI_ENABLED=true in .env).
const aiRequested = args.includes("--ai");
const targetUrl = args.find((value) => !value.startsWith("--")) || process.env.TARGET_URL;
if (!targetUrl) {
  console.error("Usage: npm run scan -- https://your-application.example [--ai]");
  process.exitCode = 1;
} else {
  try {
    const config = getConfig({ targetUrl, ...(aiRequested ? { aiEnabled: Boolean(process.env.OPENAI_API_KEY) } : {}) });
    const report = await runAccessibilityScan(config, (event) => {
      if (["progress", "complete", "page-error", "ai-error", "browser-closed", "scan-stopped"].includes(event.type)) console.log(event.message);
    });
    const stopped = report.status === "stopped";
    if (stopped) {
      const reason = typeof report.stopReason === "string" ? report.stopReason : report.stopReason?.message;
      console.log(`Scan stopped: ${reason || "the test browser was closed"}. Partial results from ${report.pages?.length || 0} page(s) were saved.`);
    }
    console.log(`${stopped ? "Partial report" : "Report"}: reports/${report.id}/vpat_draft.json`);
    // A stopped scan may have fallen back to a checkpoint, which writes no ACR files.
    if (!stopped || existsSync(path.join(config.reportsDir, report.id, "ACR_VPAT_Report.csv"))) console.log(`ACR: reports/${report.id}/ACR_VPAT_Report.csv`);
    // Exit code 2 marks an incomplete run, as scripts/run-journey.js does.
    if (stopped) process.exitCode = 2;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
