import fs from "node:fs/promises";
import path from "node:path";
import { isUnsafeControlLabel } from "../scanner/actions.js";

// Scripted end-to-end journeys (for example login → KYC form → confirmation)
// run in an explicitly declared environment with approved test data.
//
// Safety rules enforced here, before and during a run:
// - environment must be "sandbox", "staging" or "production-read-only";
// - every page must stay within allowedOrigins, or the journey stops;
// - a step whose control looks consequential (Submit, Pay, Delete, ...) runs
//   only if it is marked "consequential": true, the environment is sandbox or
//   staging, and an authorization reference is recorded;
// - values come from a separate local test-data file and are masked in reports.
export const ENVIRONMENTS = ["sandbox", "staging", "production-read-only"];
export const ACTIONS = ["goto", "click", "fill", "select", "check", "uncheck", "press", "waitFor", "assert", "checkpoint"];
const TARGET_KEYS = ["role", "name", "label", "text", "placeholder", "testId", "selector"];

export function validateJourney(journey) {
  const errors = [];
  if (!journey || typeof journey !== "object" || Array.isArray(journey)) return ["The journey must be a JSON object."];
  if (!text(journey.name)) errors.push("name is required.");
  if (!ENVIRONMENTS.includes(journey.environment)) errors.push(`environment must be one of: ${ENVIRONMENTS.join(", ")}.`);
  let start;
  try { start = new URL(journey.startUrl); if (!["http:", "https:"].includes(start.protocol)) throw new Error(); } catch { errors.push("startUrl must be an http or https URL."); }
  const origins = Array.isArray(journey.allowedOrigins) ? journey.allowedOrigins : [];
  if (!origins.length) errors.push("allowedOrigins must list the websites the journey may visit.");
  for (const origin of origins) { try { if (new URL(origin).origin !== origin.replace(/\/$/, "")) throw new Error(); } catch { errors.push(`allowedOrigins entry "${origin}" must be an origin such as https://app.example.com.`); } }
  if (start && origins.length && !origins.map((origin) => origin.replace(/\/$/, "")).includes(start.origin)) errors.push("startUrl must be inside allowedOrigins.");
  if (!Array.isArray(journey.steps) || !journey.steps.length) errors.push("steps must be a non-empty array.");
  if (journey.device !== undefined && !["desktop", "mobile"].includes(journey.device)) errors.push('device must be "desktop" or "mobile".');
  const consequential = (journey.steps || []).some((step) => step?.consequential === true);
  if (consequential && journey.environment === "production-read-only") errors.push("Consequential steps are not allowed in production-read-only journeys.");
  if (consequential && !text(journey.authorization?.reference)) errors.push("authorization.reference is required when a journey contains consequential steps.");
  (journey.steps || []).forEach((step, index) => {
    const where = `Step ${index + 1}`;
    if (!step || typeof step !== "object") { errors.push(`${where} must be an object.`); return; }
    if (!ACTIONS.includes(step.action)) { errors.push(`${where}: action must be one of ${ACTIONS.join(", ")}.`); return; }
    if (["click", "fill", "select", "check", "uncheck"].includes(step.action)) {
      if (!step.target || typeof step.target !== "object" || !TARGET_KEYS.some((key) => text(step.target[key]))) errors.push(`${where}: target needs one of ${TARGET_KEYS.join(", ")}.`);
    }
    if (["fill", "select"].includes(step.action) && step.value === undefined) errors.push(`${where}: value is required (use {{key}} to reference the test-data file).`);
    if (step.action === "goto") { try { new URL(step.url, journey.startUrl); } catch { errors.push(`${where}: url is invalid.`); } }
    if (step.action === "press" && !text(step.key)) errors.push(`${where}: key is required.`);
    if (["waitFor", "assert"].includes(step.action) && !text(step.text) && !text(step.url)) errors.push(`${where}: text or url is required.`);
    if (step.action === "checkpoint" && !text(step.name)) errors.push(`${where}: checkpoint name is required.`);
  });
  return errors;
}

export async function loadJourney(file) {
  const journey = JSON.parse(await fs.readFile(file, "utf8"));
  const errors = validateJourney(journey);
  if (errors.length) throw Object.assign(new Error(`The journey file is not valid:\n- ${errors.join("\n- ")}`), { status: 400, errors });
  let testData = {};
  if (journey.testData) {
    const dataFile = path.resolve(path.dirname(file), journey.testData);
    testData = JSON.parse(await fs.readFile(dataFile, "utf8"));
    if (!testData || typeof testData !== "object" || Array.isArray(testData)) throw Object.assign(new Error("The test-data file must be a JSON object of key/value pairs."), { status: 400 });
  }
  return { journey, testData };
}

// Replaces {{key}} references with test data. Returns the value to type and a
// masked form for the report. Unknown keys stop the journey.
export function resolveValue(value, testData) {
  const raw = String(value ?? "");
  const keys = [...raw.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((match) => match[1]);
  for (const key of keys) if (!Object.hasOwn(testData, key)) throw new Error(`Test data key "${key}" is missing from the test-data file.`);
  const resolved = raw.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => String(testData[key]));
  return { resolved, masked: keys.length ? raw : (raw ? "(literal value)" : "") };
}

export function originAllowed(url, journey) {
  try {
    const origin = new URL(url).origin;
    return journey.allowedOrigins.map((entry) => entry.replace(/\/$/, "")).includes(origin) || url === "about:blank";
  } catch { return false; }
}

// A control is consequential if its label looks like it changes data. Such a
// step must be explicitly marked, outside production, with authorization.
export function consequentialGuard(step, label, journey) {
  if (!isUnsafeControlLabel(label)) return null;
  if (step.consequential !== true) return `“${label}” looks like it submits or changes data. Mark the step "consequential": true to run it in a sandbox or staging journey.`;
  if (journey.environment === "production-read-only") return `“${label}” changes data and cannot run in a production-read-only journey.`;
  if (!text(journey.authorization?.reference)) return "Consequential steps need authorization.reference in the journey file.";
  return null;
}

export function describeTarget(target = {}) {
  return TARGET_KEYS.filter((key) => text(target[key])).map((key) => `${key}=${JSON.stringify(target[key])}`).join(" ");
}

export function locate(page, target) {
  if (text(target.selector)) return page.locator(target.selector).first();
  if (text(target.testId)) return page.getByTestId(target.testId).first();
  if (text(target.role)) return page.getByRole(target.role, text(target.name) ? { name: target.name, exact: target.exact === true } : {}).first();
  if (text(target.label)) return page.getByLabel(target.label, { exact: target.exact === true }).first();
  if (text(target.placeholder)) return page.getByPlaceholder(target.placeholder, { exact: target.exact === true }).first();
  return page.getByText(target.text, { exact: target.exact === true }).first();
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
