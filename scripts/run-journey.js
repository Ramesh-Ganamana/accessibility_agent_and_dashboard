import path from "node:path";
import { getConfig } from "../src/config.js";
import { runJourney } from "../src/journeys/runner.js";

// Usage: npm run journey -- journeys/my-journey.json
const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run journey -- journeys/<name>.json");
  process.exitCode = 1;
} else {
  try {
    const report = await runJourney({
      file: path.resolve(file),
      config: getConfig({ login: false }),
      onEvent: (event) => { if (["journey", "journey-warning", "complete"].includes(event.type)) console.log(event.message); }
    });
    console.log(`Journey ${report.journey.outcome}. Report: reports/${report.id}/vpat_draft.json`);
    process.exitCode = report.journey.outcome === "completed" ? 0 : 2;
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
