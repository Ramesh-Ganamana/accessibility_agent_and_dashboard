import { getConfig } from "./config.js";
import { runAccessibilityScan } from "./scanner/crawler.js";

const targetUrl = process.argv[2] || process.env.TARGET_URL;
if (!targetUrl) {
  console.error("Usage: npm run scan -- https://your-application.example");
  process.exitCode = 1;
} else {
  try {
    const report = await runAccessibilityScan(getConfig({ targetUrl }), (event) => {
      if (["progress", "complete", "page-error", "ai-error"].includes(event.type)) console.log(event.message);
    });
    console.log(`Report: reports/${report.id}/vpat_draft.json`);
    console.log(`ACR: reports/${report.id}/ACR_VPAT_Report.csv`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

