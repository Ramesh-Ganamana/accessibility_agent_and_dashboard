import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildAudit, validateAuditReview } from "./audit.js";
import { isBestPracticeFinding } from "./assessment.js";
import { findComplianceItem } from "./compliance.js";

const reviewWrites = new Map();
// Parsed reports with their rebuilt audit, keyed by file versions. Every
// dashboard tab requests a section, so re-parsing multi-megabyte JSON per
// request is avoided.
const reportCache = new Map();
const REPORT_CACHE_LIMIT = 12;

export async function listReports(reportsDir) {
  const entries = await fs.readdir(reportsDir, { withFileTypes: true }).catch(() => []);
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      // The small summary file avoids parsing every full report for the list.
      const summaryFile = path.join(reportsDir, entry.name, "summary.json");
      const source = await fs.readFile(summaryFile, "utf8").catch(() => null)
        ?? await fs.readFile(path.join(reportsDir, entry.name, "vpat_draft.json"), "utf8");
      reports.push(reportListing(JSON.parse(source)));
    } catch {}
  }
  return reports.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function reportListing(report) {
  return {
    id: report.id, targetUrl: report.targetUrl, startedAt: report.startedAt, completedAt: report.completedAt,
    status: report.status || (report.completedAt ? "complete" : "unknown"), summary: report.summary
  };
}

export async function readReport(reportsDir, id) {
  const directory = await reportDirectory(reportsDir, id);
  const reportPath = await reportFile(directory, "vpat_draft.json");
  const reviewsPath = path.join(directory, "audit-reviews.json");
  const version = `${await fileVersion(reportPath)}|${await fileVersion(reviewsPath)}`;
  const cached = reportCache.get(directory);
  if (cached?.version === version) return structuredClone(cached.report);

  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  report.status ||= report.completedAt ? "complete" : "unknown";
  // Older reports stored axe best-practice rules among confirmed WCAG issues.
  if (!Array.isArray(report.bestPractices)) {
    const issues = Array.isArray(report.issues) ? report.issues : [];
    report.bestPractices = issues.filter(isBestPracticeFinding).map((finding) => ({ ...finding, category: "best-practice" }));
    report.issues = issues.filter((finding) => !isBestPracticeFinding(finding));
  }
  report.auditReviews = await readReviews(directory) ?? (Array.isArray(report.auditReviews) ? report.auditReviews : []);
  report.audit = buildAudit(report);
  report.acr = report.audit.criteria;
  reportCache.delete(directory);
  reportCache.set(directory, { version, report });
  if (reportCache.size > REPORT_CACHE_LIMIT) reportCache.delete(reportCache.keys().next().value);
  return structuredClone(report);
}

async function fileVersion(file) {
  try { const stat = await fs.stat(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return "none"; }
}

export async function appendAuditReview(reportsDir, id, input) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Object.assign(new Error("Invalid report id."), { status: 400 });
  // Reserve the append position before asynchronous path checks. Otherwise two
  // callers can overtake each other while realpath resolves, reversing history.
  const resolvedKey = path.resolve(reportsDir, id);
  const queueKey = process.platform === "win32" ? resolvedKey.toLowerCase() : resolvedKey;
  const previous = reviewWrites.get(queueKey) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const directory = await reportDirectory(reportsDir, id);
    const report = await readReport(reportsDir, id);
    let review;
    try { review = validateAuditReview(report, input, { findComplianceItem: (targetId) => findComplianceItem(reportsDir, targetId) }); }
    catch (error) { error.status = 400; throw error; }
    const reviews = [...report.auditReviews, review];
    const destination = await reportFile(directory, "audit-reviews.json", true);
    const temporary = path.join(directory, `audit-reviews-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(reviews, null, 2), { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary, destination);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return readReport(reportsDir, id);
  });
  reviewWrites.set(queueKey, operation);
  try { return await operation; }
  finally { if (reviewWrites.get(queueKey) === operation) reviewWrites.delete(queueKey); }
}

async function reportDirectory(reportsDir, id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Object.assign(new Error("Invalid report id."), { status: 400 });
  const root = await fs.realpath(reportsDir);
  const expected = path.resolve(root, id);
  const directory = await fs.realpath(expected);
  if (directory.toLowerCase() !== expected.toLowerCase()) throw Object.assign(new Error("Invalid report directory."), { status: 400 });
  return directory;
}

async function reportFile(directory, name, optional = false) {
  const expected = path.join(directory, name);
  try {
    const resolved = await fs.realpath(expected);
    if (resolved.toLowerCase() !== expected.toLowerCase()) throw Object.assign(new Error("Invalid report file."), { status: 400 });
    return resolved;
  } catch (error) { if (optional && error.code === "ENOENT") return expected; throw error; }
}

async function readReviews(directory) {
  try {
    const reviews = JSON.parse(await fs.readFile(await reportFile(directory, "audit-reviews.json"), "utf8"));
    if (!Array.isArray(reviews)) throw new Error("The audit review history is invalid.");
    return reviews;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}


// Product details for the VPAT 2.5 exports, saved next to the report.
const VPAT_PROFILE_FIELDS = [["productName", 200], ["productVersion", 100], ["reportDate", 10], ["description", 4000], ["contact", 1000], ["notes", 4000], ["evaluationMethods", 4000]];

export async function readVpatProfile(reportsDir, id) {
  const directory = await reportDirectory(reportsDir, id);
  try { return JSON.parse(await fs.readFile(path.join(directory, "vpat-profile.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

export async function saveVpatProfile(reportsDir, id, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Product details are required."), { status: 400 });
  const directory = await reportDirectory(reportsDir, id);
  const profile = {};
  for (const [field, limit] of VPAT_PROFILE_FIELDS) {
    const value = String(input[field] ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    if (value.length > limit) throw Object.assign(new Error(`${field} must be at most ${limit} characters.`), { status: 400 });
    profile[field] = value;
  }
  if (profile.reportDate && !/^\d{4}-\d{2}-\d{2}$/.test(profile.reportDate)) throw Object.assign(new Error("Report date must be YYYY-MM-DD."), { status: 400 });
  const temporary = path.join(directory, `vpat-profile-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(profile, null, 2), "utf8");
    await fs.rename(temporary, path.join(directory, "vpat-profile.json"));
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return profile;
}
