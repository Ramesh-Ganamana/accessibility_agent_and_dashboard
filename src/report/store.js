import fs from "node:fs/promises";
import path from "node:path";

export async function listReports(reportsDir) {
  const entries = await fs.readdir(reportsDir, { withFileTypes: true }).catch(() => []);
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const content = await fs.readFile(path.join(reportsDir, entry.name, "vpat_draft.json"), "utf8");
      const report = JSON.parse(content);
      reports.push({ id: report.id, targetUrl: report.targetUrl, startedAt: report.startedAt, completedAt: report.completedAt, summary: report.summary });
    } catch {}
  }
  return reports.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export async function readReport(reportsDir, id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid report id.");
  const content = await fs.readFile(path.join(reportsDir, id, "vpat_draft.json"), "utf8");
  return JSON.parse(content);
}

