import { parseActionExclusions } from "./browser/action-exclusions.js";

export function scanRequestError(body) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(body)) return "The scan request must be a JSON object.";
  try { parseActionExclusions(body.excludeActionLabels); } catch (error) { return error.message; }
  if (body.auth !== undefined && !object(body.auth)) return "Authentication settings must be a JSON object.";
  if (body.screenReaders !== undefined && !object(body.screenReaders)) return "Screen-reader settings must be a JSON object.";
  if (body.audit !== undefined) {
    if (!object(body.audit)) return "Audit settings must be a JSON object.";
    if (body.audit.profile !== undefined && !["general", "financial"].includes(body.audit.profile)) return "Choose a general or financial audit profile.";
    if (body.audit.wcagVersion !== undefined && !["2.1", "2.2"].includes(body.audit.wcagVersion)) return "Choose WCAG 2.1 or 2.2.";
    if (body.audit.level !== undefined && body.audit.level !== "AA") return "The audit supports WCAG level AA, including level A.";
  }
  if (body.device !== undefined && !["desktop", "mobile"].includes(body.device)) return "Choose a desktop or mobile viewport.";
  if (body.device === "mobile" && body.screenReaders?.nvda) return "Actual NVDA runs in a desktop browser window. Choose the desktop viewport to run NVDA.";
  if (typeof body.targetUrl !== "string") return "Enter a valid http or https URL.";
  return null;
}
