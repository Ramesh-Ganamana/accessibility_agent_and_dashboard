import { createHash } from "node:crypto";

export function summarizeTiming(actions = []) {
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  };
  const byKind = {};
  for (const action of actions.filter((entry) => entry.timing)) (byKind[action.kind || "focus"] ||= []).push(action.timing);
  return Object.fromEntries(Object.entries(byKind).map(([kind, timings]) => [kind, {
    commands: timings.length,
    ...Object.fromEntries(["armMs", "commandMs", "firstSpeechMs", "speechMs", "disarmMs", "inspectMs", "totalMs"].map((name) => [name, median(timings.map((timing) => timing[name]))]))
  }]));
}

export function liveStateIdentity(state) {
  // Text, headings and banner contents change independently of interaction.
  // Route and structural interactive state are the attribution boundary.
  return createHash("sha256").update(JSON.stringify({
    url: state.url, dialogs: state.dialogs || [], tabs: state.tabs || [], expanded: state.expanded || [], frames: state.frames || []
  })).digest("hex");
}

export async function inspectLiveState(page) {
  return page.evaluate(() => {
    const visible = (node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none";
    const selector = (node) => {
      if (node.id) return `${node.tagName.toLowerCase()}#${node.id}`;
      const parts = [];
      for (let parent = node; parent && parent !== document.body; parent = parent.parentElement) {
        if (parent.hasAttribute("data-rambo-nvda-anchor")) continue;
        const siblings = [...(parent.parentElement?.children || [])].filter((sibling) => sibling.tagName === parent.tagName);
        parts.unshift(`${parent.tagName.toLowerCase()}:${siblings.indexOf(parent)}`);
      }
      return parts.join(">");
    };
    const values = (query, attribute) => [...document.querySelectorAll(query)].filter(visible).map((node) => `${selector(node)}:${attribute ? node.getAttribute(attribute) : node.getAttribute("role") || node.tagName}`).sort();
    return {
      url: location.href,
      dialogs: values('dialog[open],[role="dialog"],[role="alertdialog"],[role="menu"]'),
      tabs: values('[role="tab"][aria-selected="true"]', "aria-selected"),
      expanded: values('[aria-expanded="true"]', "aria-expanded"),
      frames: values("iframe", "src"),
      headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]').length,
      tables: document.querySelectorAll('table,[role="table"],[role="grid"]').length,
      forms: document.querySelectorAll("form,input,select,textarea").length
    };
  });
}

export function buildNvdaLivePlan(config = {}, structure = {}) {
  const enabled = new Set(config.tests || ["focus", "reading", "headings", "tables"]);
  const bounded = (value, fallback, max) => Math.max(1, Math.min(max, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback));
  const plan = [];
  if (enabled.has("reading")) plan.push({ kind: "reading", command: "Read available content to end", addonKind: "say-all", maxDurationMs: bounded(config.readingTimeoutMs, 300_000, 1_800_000) });
  if (enabled.has("headings") && structure.headings) for (let n = 0; n < bounded(config.headingStops, 3, 10); n++) plan.push({ kind: "headings", command: "Next heading", addonKind: "next-heading" });
  if (enabled.has("tables") && structure.tables) {
    plan.push({ kind: "tables", command: "Next table", addonKind: "next-table" });
    for (let n = 1; n < bounded(config.tableStops, 3, 10); n++) plan.push({ kind: "tables", command: n % 2 ? "Next table column" : "Next table row", addonKind: n % 2 ? "next-column" : "next-row" });
  }
  if (enabled.has("focus")) for (let n = 0; n < bounded(config.tabStops, 12, 30); n++) plan.push({ kind: "focus", command: "Tab" });
  return plan;
}
