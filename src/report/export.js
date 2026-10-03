import fs from "node:fs/promises";
import path from "node:path";
import { buildAcrRows, WCAG_REGISTRY } from "../scanner/wcag.js";

export async function writeReportFiles(report, outputDir) {
  report.acr = buildAcrRows(report.issues);
  report.wcagRegistry = WCAG_REGISTRY;
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "vpat_draft.json"), JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(path.join(outputDir, "ACR_VPAT_Report.csv"), toCsv(report.acr), "utf8");
  return report;
}

function toCsv(rows) {
  const headers = ["WCAG Success Criterion", "Level", "Conformance", "Issue Count", "Remarks and Explanations"];
  const values = rows.map((row) => [row.criterion, row.level, row.status, row.issueCount, row.remarks]);
  return [headers, ...values].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value) {
  const string = String(value ?? "");
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

