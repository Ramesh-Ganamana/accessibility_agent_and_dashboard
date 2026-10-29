import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

// A per-site remediation backlog that persists across scans. Confirmed WCAG
// findings are added automatically; any other finding can be tracked on
// request. A later scan reopens an item marked fixed if the same defect is
// found again. A defect missing from a later scan is flagged for verification,
// never closed automatically: absence from one crawl is not proof of a fix.
export const BACKLOG_STATUSES = ["open", "in-progress", "fixed", "verified", "reopened", "wont-fix", "false-positive"];
const CLOSED = new Set(["fixed", "verified", "wont-fix", "false-positive"]);
const writes = new Map();

export function backlogHost(targetUrl) {
  try { return new URL(targetUrl).hostname.toLowerCase(); } catch { return ""; }
}

export function backlogItemKey(finding) {
  const target = (Array.isArray(finding.target) ? finding.target.flat(Infinity) : [finding.target]).map((part) => String(part || "").trim()).filter(Boolean).join(" → ");
  const scope = finding.region === "global" ? "site" : routeKey(finding.documentUrl || finding.pageUrl);
  return createHash("sha1").update([finding.ruleId, target, scope].join("\u0000")).digest("hex").slice(0, 16);
}

function routeKey(value) {
  try {
    const url = new URL(value);
    const hashRoute = /^#(?:!\/|\/)/.test(url.hash) ? url.hash : "";
    return `${url.pathname.replace(/\/$/, "") || "/"}${url.search}${hashRoute}`;
  } catch { return String(value || ""); }
}

function backlogFile(reportsDir, host) {
  if (!/^[a-z0-9.-]+$/.test(host)) throw Object.assign(new Error("Invalid site name."), { status: 400 });
  return path.join(reportsDir, "_backlog", `${host}.json`);
}

export async function readBacklog(reportsDir, host) {
  try {
    const data = JSON.parse(await fs.readFile(backlogFile(reportsDir, host), "utf8"));
    return { host, items: Array.isArray(data.items) ? data.items : [], syncedReports: Array.isArray(data.syncedReports) ? data.syncedReports : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { host, items: [], syncedReports: [] };
    throw error;
  }
}

async function mutate(reportsDir, host, change) {
  const file = backlogFile(reportsDir, host);
  const previous = writes.get(file) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const backlog = await readBacklog(reportsDir, host);
    const result = await change(backlog);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ host, items: backlog.items, syncedReports: backlog.syncedReports.slice(-50) }, null, 2), "utf8");
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    return result ?? backlog;
  });
  writes.set(file, operation);
  try { return await operation; } finally { if (writes.get(file) === operation) writes.delete(file); }
}

function describe(finding) {
  return {
    ruleId: finding.ruleId, help: finding.help || finding.ruleId, impact: finding.impact || "moderate",
    wcag: finding.wcag || [], category: finding.category || (finding.findingType === "needs-review" ? "needs-review" : "wcag"),
    pageUrl: finding.pageUrl, documentUrl: finding.documentUrl || null, region: finding.region || "main",
    target: Array.isArray(finding.target) ? finding.target.flat(Infinity).join(" → ") : String(finding.target || ""),
    helpUrl: finding.helpUrl || null
  };
}

// Applies one completed report to the site's backlog. A partial scan (stopped,
// failed or in progress) is ignored: findings it never reached would otherwise
// be flagged as not found.
export async function syncBacklog(reportsDir, report) {
  const host = backlogHost(report.targetUrl);
  if (!host) return null;
  if (report.status && report.status !== "complete") return { host, added: 0, reopened: 0, notFound: 0, alreadySynced: false, skipped: `The ${report.status} scan is partial and was not applied to the backlog.` };
  return mutate(reportsDir, host, (backlog) => {
    const at = report.completedAt || new Date().toISOString();
    if (backlog.syncedReports.includes(report.id)) return { host, added: 0, reopened: 0, notFound: 0, alreadySynced: true };
    const byKey = new Map(backlog.items.map((item) => [item.key, item]));
    const present = new Set();
    let added = 0;
    let reopened = 0;
    for (const finding of report.issues || []) {
      if (!(finding.wcag || []).length) continue;
      const key = backlogItemKey(finding);
      present.add(key);
      const existing = byKey.get(key);
      if (!existing) {
        const item = { key, ...describe(finding), status: "open", owner: "", notes: "", dueDate: "", firstSeen: { reportId: report.id, at }, lastSeen: { reportId: report.id, at }, latestScan: "present", history: [{ at, change: "added", reportId: report.id, note: "Confirmed finding added by the scan." }] };
        backlog.items.push(item);
        byKey.set(key, item);
        added += 1;
        continue;
      }
      Object.assign(existing, describe(finding), { lastSeen: { reportId: report.id, at }, latestScan: "present" });
      if (existing.status === "fixed" || existing.status === "verified") {
        existing.history.push({ at, change: "status", from: existing.status, to: "reopened", reportId: report.id, note: "The same defect was found again by a later scan." });
        existing.status = "reopened";
        reopened += 1;
      }
    }
    // Items not found: only judged where this scan actually covered the page.
    const covered = new Set((report.pages || []).filter((page) => !page.error).map((page) => routeKey(page.url)));
    let notFound = 0;
    for (const item of backlog.items) {
      if (present.has(item.key) || item.category !== "wcag") continue;
      const scope = item.region === "global" ? (covered.size ? "covered" : null) : covered.has(routeKey(item.pageUrl)) ? "covered" : null;
      item.latestScan = scope ? "not-found" : "not-covered";
      item.latestScanReportId = report.id;
      if (scope) notFound += 1;
    }
    backlog.syncedReports.push(report.id);
    return { host, added, reopened, notFound, alreadySynced: false };
  });
}

// Adds a finding (for example a needs-review or best-practice item) to the backlog.
export async function trackFinding(reportsDir, report, findingId) {
  const finding = [...(report.issues || []), ...(report.incomplete || []), ...(report.bestPractices || [])].find((entry) => entry.id === findingId);
  if (!finding) throw Object.assign(new Error("That finding does not belong to this report."), { status: 400 });
  const host = backlogHost(report.targetUrl);
  return mutate(reportsDir, host, (backlog) => {
    const key = backlogItemKey(finding);
    const at = new Date().toISOString();
    let item = backlog.items.find((entry) => entry.key === key);
    if (!item) {
      item = { key, ...describe(finding), status: "open", owner: "", notes: "", dueDate: "", firstSeen: { reportId: report.id, at }, lastSeen: { reportId: report.id, at }, latestScan: "present", history: [{ at, change: "added", reportId: report.id, note: "Added to the backlog by a reviewer." }] };
      backlog.items.push(item);
    }
    return item;
  });
}

export async function updateBacklogItem(reportsDir, host, key, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("An update object is required."), { status: 400 });
  return mutate(reportsDir, host, (backlog) => {
    const item = backlog.items.find((entry) => entry.key === key);
    if (!item) throw Object.assign(new Error("Backlog item not found."), { status: 404 });
    const at = new Date().toISOString();
    if (input.status !== undefined) {
      if (!BACKLOG_STATUSES.includes(input.status)) throw Object.assign(new Error(`Status must be one of: ${BACKLOG_STATUSES.join(", ")}.`), { status: 400 });
      if (input.status === "verified" && item.latestScan === "present") throw Object.assign(new Error("The latest scan still found this defect. Fix it and run a new scan before marking it verified."), { status: 400 });
      if (input.status !== item.status) item.history.push({ at, change: "status", from: item.status, to: input.status, note: text(input.note, 1000) });
      item.status = input.status;
    }
    for (const [field, limit] of [["owner", 200], ["notes", 4000], ["dueDate", 10]]) {
      if (input[field] === undefined) continue;
      const value = text(input[field], limit);
      if (field === "dueDate" && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Object.assign(new Error("Due date must be YYYY-MM-DD."), { status: 400 });
      if (value !== item[field]) item.history.push({ at, change: field, from: item[field], to: value });
      item[field] = value;
    }
    item.history = item.history.slice(-100);
    return item;
  });
}

export function summarizeBacklog(backlog) {
  const count = (predicate) => backlog.items.filter(predicate).length;
  return {
    total: backlog.items.length,
    open: count((item) => !CLOSED.has(item.status)),
    byStatus: Object.fromEntries(BACKLOG_STATUSES.map((status) => [status, count((item) => item.status === status)])),
    notFoundAwaitingVerification: count((item) => item.latestScan === "not-found" && !["verified", "wont-fix", "false-positive"].includes(item.status)),
    reopened: count((item) => item.status === "reopened")
  };
}

export function renderBacklogCsv(backlog) {
  const headers = ["Status", "Issue", "Rule", "WCAG", "Impact", "Page", "Element", "Owner", "Due", "Latest scan", "First seen", "Last seen", "Notes"];
  const rows = backlog.items.map((item) => [item.status, item.help, item.ruleId, item.wcag.join("; "), item.impact, item.documentUrl || item.pageUrl, item.target, item.owner, item.dueDate, item.latestScan, item.firstSeen?.at, item.lastSeen?.at, item.notes]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value) {
  const raw = String(value ?? "");
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function text(value, limit) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, limit);
}
