import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regulatory requirement checklists (GIGW 3.0, SEBI circulars, and imported
// sets such as a licensed IS 17802 checklist). Reviewers record a documented
// decision per item per report; nothing is decided automatically. Linked WCAG
// criteria show the scan's evidence for reference only.
export const COMPLIANCE_STATUSES = ["met", "partially-met", "not-met", "not-applicable"];
const builtInFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "compliance-data", "public-sources.json");
let builtIn;

function loadBuiltIn() {
  builtIn ||= JSON.parse(fs.readFileSync(builtInFile, "utf8"));
  return builtIn;
}

function customDir(reportsDir) {
  return path.join(reportsDir, "_compliance");
}

export function listComplianceSets(reportsDir) {
  const data = loadBuiltIn();
  const custom = [];
  for (const name of fs.existsSync(customDir(reportsDir)) ? fs.readdirSync(customDir(reportsDir)) : []) {
    if (!name.endsWith(".json")) continue;
    try { custom.push({ ...JSON.parse(fs.readFileSync(path.join(customDir(reportsDir), name), "utf8")), builtIn: false }); } catch {}
  }
  return { notice: data.notice, retrievedOn: data.retrievedOn, sources: data.sources, sets: [...data.sets, ...custom] };
}

export function findComplianceItem(reportsDir, targetId) {
  const [setId, itemId] = String(targetId || "").split("::");
  const set = listComplianceSets(reportsDir).sets.find((entry) => entry.id === setId);
  const item = set?.items.find((entry) => entry.id === itemId);
  return item ? { ...item, setId, criterion: `${item.reference} ${item.title}` } : null;
}

// Imports a custom checklist from JSON ({ id, title, items: [...] }) or CSV with
// columns reference,title,requirement[,category,wcag,verification,source].
export async function importComplianceSet(reportsDir, input) {
  if (!input || typeof input !== "object") throw Object.assign(new Error("A checklist is required."), { status: 400 });
  const id = String(input.id || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{1,60}$/.test(id)) throw Object.assign(new Error("Checklist id must be 2–60 lowercase letters, digits, dots or dashes."), { status: 400 });
  if (loadBuiltIn().sets.some((set) => set.id === id)) throw Object.assign(new Error("That id belongs to a built-in checklist."), { status: 400 });
  const title = String(input.title || "").trim().slice(0, 200);
  if (!title) throw Object.assign(new Error("A checklist title is required."), { status: 400 });
  const rows = input.format === "csv" ? parseCsv(String(input.csv || "")) : Array.isArray(input.items) ? input.items : null;
  if (!rows?.length) throw Object.assign(new Error("The checklist has no items."), { status: 400 });
  if (rows.length > 1_000) throw Object.assign(new Error("A checklist may contain at most 1000 items."), { status: 400 });
  const seen = new Set();
  const items = rows.map((row, index) => {
    const reference = clean(row.reference, 120);
    const requirement = clean(row.requirement, 2_000);
    if (!reference || !requirement) throw Object.assign(new Error(`Item ${index + 1} needs a reference and a requirement.`), { status: 400 });
    let itemId = `${reference.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "item"}-${index + 1}`;
    while (seen.has(itemId)) itemId += "x";
    seen.add(itemId);
    const wcag = (Array.isArray(row.wcag) ? row.wcag : String(row.wcag || "").split(/[;,\s]+/)).map((value) => String(value).trim()).filter((value) => /^\d+\.\d+\.\d+$/.test(value));
    return { id: itemId, reference, title: clean(row.title, 160) || reference, requirement, category: clean(row.category, 40) || "other", wcag, verification: clean(row.verification, 400), source: clean(row.source, 200) || title, confidence: "imported" };
  });
  await fsp.mkdir(customDir(reportsDir), { recursive: true });
  const set = { id, title, publisher: clean(input.publisher, 200), importedAt: new Date().toISOString(), items };
  await fsp.writeFile(path.join(customDir(reportsDir), `${id}.json`), JSON.stringify(set, null, 2), "utf8");
  return { id, title, items: items.length };
}

// The sets with each item's latest documented decision in this report.
export function complianceForReport(reportsDir, report) {
  const catalog = listComplianceSets(reportsDir);
  const reviews = Array.isArray(report.auditReviews) ? report.auditReviews : [];
  const criteria = new Map((report.audit?.criteria || []).map((criterion) => [criterion.id, criterion]));
  return {
    ...catalog,
    sets: catalog.sets.map((set) => {
      const items = set.items.map((item) => {
        const targetId = `${set.id}::${item.id}`;
        const latest = [...reviews].reverse().find((review) => review?.kind === "compliance-item" && review.targetId === targetId);
        const review = latest && COMPLIANCE_STATUSES.includes(latest.status) && [latest.reviewer, latest.notes, latest.scope].every((value) => typeof value === "string" && value.trim()) ? latest : null;
        return { ...item, targetId, status: review?.status || "not-reviewed", review, relatedWcag: item.wcag.map((id) => ({ id, status: criteria.get(id)?.status || "Not in scope", findings: criteria.get(id)?.issueCount || 0 })) };
      });
      const count = (status) => items.filter((item) => item.status === status).length;
      return { ...set, items, summary: { total: items.length, reviewed: items.length - count("not-reviewed"), met: count("met"), partiallyMet: count("partially-met"), notMet: count("not-met"), notApplicable: count("not-applicable") } };
    })
  };
}

export function renderComplianceCsv(compliance) {
  const headers = ["Checklist", "Reference", "Requirement", "Category", "Related WCAG (scan status)", "Decision", "Reviewer", "Scope", "Notes", "Evidence", "Source", "Source URL"];
  const rows = compliance.sets.flatMap((set) => set.items.map((item) => [set.title, item.reference, item.requirement, item.category,
    item.relatedWcag.map((entry) => `${entry.id} (${entry.status})`).join("; "), item.status, item.review?.reviewer, item.review?.scope, item.review?.notes, (item.review?.evidence || []).join("; "), item.sourceTitle || item.source, item.sourceUrl]));
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function parseCsv(text) {
  const records = [];
  let field = "";
  let row = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value.trim())) records.push(row);
      row = [];
    } else field += character;
  }
  row.push(field);
  if (row.some((value) => value.trim())) records.push(row);
  const [header, ...body] = records;
  if (!header) return [];
  const keys = header.map((value) => value.trim().toLowerCase());
  if (!keys.includes("reference") || !keys.includes("requirement")) throw Object.assign(new Error("CSV needs a header row with at least reference and requirement columns."), { status: 400 });
  return body.map((values) => Object.fromEntries(keys.map((key, position) => [key, values[position] ?? ""])));
}

function clean(value, limit) {
  return String(value ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function csvCell(value) {
  const raw = String(value ?? "");
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
