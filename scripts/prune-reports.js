import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../src/config.js";

// Removes old scan reports to reclaim disk space. Dry run by default.
//   npm run reports:prune -- --keep 20            keep the newest 20 completed reports per site
//   npm run reports:prune -- --older-than 90      also require reports to be older than 90 days
//   npm run reports:prune -- --keep 20 --apply    actually delete
// The newest report of every site is always kept. In-progress reports (running
// or interrupted) and stopped ones (test browser closed, partial results saved)
// are deleted only with --include-interrupted.
const PARTIAL = new Set(["in-progress", "stopped"]);

// Picks the reports to delete from [{host, startedAt, status}] (startedAt in ms).
export function selectReportsToPrune(reports, { keep = 20, cutoff = Infinity, includeInterrupted = false } = {}) {
  const byHost = Map.groupBy ? Map.groupBy(reports, (report) => report.host) : groupBy(reports, (report) => report.host);
  const remove = [];
  for (const [, siteReports] of byHost) {
    const sorted = [...siteReports].sort((a, b) => b.startedAt - a.startedAt);
    const completed = sorted.filter((report) => report.status === "complete");
    for (const [index, report] of sorted.entries()) {
      if (report === sorted[0]) continue;
      if (PARTIAL.has(report.status) && !includeInterrupted) continue;
      if (report.status === "complete" && completed.indexOf(report) < keep) continue;
      if (report.startedAt > cutoff) continue;
      if (report.status !== "complete" && !PARTIAL.has(report.status) && report.status !== "failed" && index < keep) continue;
      remove.push(report);
    }
  }
  return remove;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback;
  };
  const keep = Math.max(1, Math.trunc(option("--keep", 20)));
  const olderThanDays = option("--older-than", 0);
  const apply = args.includes("--apply");
  const includeInterrupted = args.includes("--include-interrupted");
  const reportsDir = path.resolve(getConfig().reportsDir);

  const entries = await fs.readdir(reportsDir, { withFileTypes: true }).catch(() => []);
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name) || entry.name.startsWith("_")) continue;
    const directory = path.join(reportsDir, entry.name);
    try {
      const summaryFile = await fs.readFile(path.join(directory, "summary.json"), "utf8").catch(() => null);
      const data = JSON.parse(summaryFile ?? await fs.readFile(path.join(directory, "vpat_draft.json"), "utf8"));
      reports.push({ id: entry.name, directory, host: hostOf(data.targetUrl), startedAt: Date.parse(data.startedAt) || 0, status: data.status || (data.completedAt ? "complete" : "unknown"), bytes: await sizeOf(directory) });
    } catch {
      // Folders without a readable report are left alone.
    }
  }

  const cutoff = olderThanDays > 0 ? Date.now() - olderThanDays * 86_400_000 : Infinity;
  const remove = selectReportsToPrune(reports, { keep, cutoff, includeInterrupted });

  const total = reports.reduce((sum, report) => sum + report.bytes, 0);
  const freed = remove.reduce((sum, report) => sum + report.bytes, 0);
  console.log(`${reports.length} reports use ${mb(total)}. ${remove.length} would be removed, freeing ${mb(freed)} (keep newest ${keep} completed per site${olderThanDays > 0 ? `, older than ${olderThanDays} days` : ""}).`);
  for (const report of remove) console.log(`  ${apply ? "deleting" : "would delete"} ${report.id}  ${report.host}  ${report.status}  ${mb(report.bytes)}`);
  if (apply) {
    for (const report of remove) {
      // Only direct children of the reports folder are ever removed.
      if (path.dirname(report.directory) !== reportsDir) continue;
      await fs.rm(report.directory, { recursive: true, force: true });
    }
    console.log(`Removed ${remove.length} report(s).`);
  } else if (remove.length) {
    console.log("Dry run only. Add --apply to delete these reports.");
  }
}

function hostOf(value) { try { return new URL(value).hostname; } catch { return "unknown"; } }
function mb(bytes) { return `${(bytes / 1048576).toFixed(1)} MB`; }
function groupBy(items, key) { const map = new Map(); for (const item of items) { const value = key(item); map.set(value, [...(map.get(value) || []), item]); } return map; }
async function sizeOf(directory) {
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? await sizeOf(full) : (await fs.stat(full)).size;
  }
  return bytes;
}
