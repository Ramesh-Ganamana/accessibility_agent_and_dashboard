import { $, fetchJson } from "../shared/ui.js";
import { state } from "../state.js";

function parseActionExclusionEntries(value) {
  const urlEntry = /^(?:https?:\/\/|\/|\.\.?\/)/i;
  const splitLine = (line) => {
    const entries = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted) {
        if (char !== '"') current += char;
        else if (line[index + 1] === '"') { current += '"'; index += 1; }
        else quoted = false;
      } else if (char === '"' && !current.trim() && line.indexOf('"', index + 1) > index) { current = ""; quoted = true; }
      else if (char === "\\" && line[index + 1] === ",") { current += ","; index += 1; }
      else if (char === ",") {
        const rest = line.slice(index + 1);
        if (urlEntry.test(current.trim()) && current.includes("?") && /^\S/.test(rest) && !urlEntry.test(rest)) current += char;
        else { entries.push(current); current = ""; }
      } else current += char;
    }
    entries.push(current);
    return entries;
  };
  return [...new Set(String(value || "").split(/\r\n|[\n\r\u2028\u2029]/).flatMap(splitLine).map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function renderActionExclusionSummary() {
  const entries = parseActionExclusionEntries($("#exclude-action-labels").value);
  const server = state.serverActionExclusions || [];
  const parts = [];
  if (entries.length > 100) parts.push(`${entries.length} entries: use at most 100.`);
  else if (entries.length) parts.push(`${entries.length} ${entries.length === 1 ? "entry" : "entries"} will not be clicked: ${entries.join(" · ")}.`);
  if (server.length) parts.push(`${server.length} ${server.length === 1 ? "entry" : "entries"} from EXCLUDE_ACTION_LABELS also ${server.length === 1 ? "applies" : "apply"}: ${server.join(" · ")}.`);
  $("#exclude-action-summary").textContent = parts.join(" ");
}

async function loadCapabilities() {
  try {
    const health = await fetchJson("/api/health");
    state.serverActionExclusions = Array.isArray(health.actionExclusions?.serverEntries) ? health.actionExclusions.serverEntries : [];
    renderActionExclusionSummary();
    const checkbox = $("#auth-ai-enabled");
    checkbox.disabled = !health.aiLoginAvailable;
    checkbox.checked = Boolean(health.aiLoginAvailable);
    $("#auth-ai-status").textContent = health.aiLoginAvailable
      ? "Available · credentials and input values are excluded"
      : "Add OPENAI_API_KEY to .env to enable";
    const nvdaCheckbox = $("#nvda-enabled");
    nvdaCheckbox.disabled = !health.nvda?.available;
    if (!health.nvda?.available) nvdaCheckbox.checked = false;
    const nvdaAfterCrawl = health.nvda?.order === "after-crawl";
    $("#nvda-mode-label").textContent = nvdaAfterCrawl
      ? "Run actual NVDA after the crawl (replay mode)" : "Run actual NVDA during the headed crawl";
    $("#nvda-order-note").textContent = nvdaAfterCrawl
      ? "NVDA starts after crawling and attempts to reopen recorded states in another tab. States that cannot be reproduced are reported as not tested."
      : "NVDA starts with the visible browser. Each state is scanned and tested with NVDA before crawling continues—including menus and dialogs at the same URL.";
    $("#nvda-capability-status").textContent = health.nvda?.available
      ? (nvdaAfterCrawl
        ? "Available · starts after the crawl and reopens each recorded state; speech stays local. Keep this desktop dedicated to the test."
        : "Available · scan state → NVDA checks → next state; speech stays local. Keep this desktop dedicated to the test.")
      : health.nvda?.reason || "NVDA availability could not be determined";
  } catch {
    $("#auth-ai-status").textContent = "Availability could not be checked";
    $("#nvda-capability-status").textContent = "NVDA availability could not be checked";
  }
}

export { renderActionExclusionSummary, loadCapabilities };
