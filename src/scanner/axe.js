import axe from "axe-core";
import { criteriaFromTags } from "./wcag.js";
import { sanitizeUrl } from "../url-security.js";

export async function scanFrameWithAxe(frame, pageUrl, state = "default") {
  try {
    const scan = await frame.evaluate(async (source) => {
      if (!globalThis.axe) (0, eval)(source);
      globalThis.__clarityDocumentToken ||= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const results = await globalThis.axe.run(document, {
        resultTypes: ["violations", "incomplete"],
        reporter: "v2",
        // Playwright scans every frame independently below. Prevent axe from
        // attempting to reach through a parent frame's cross-origin boundary.
        iframes: false
      });
      return { results, documentToken: globalThis.__clarityDocumentToken };
    }, axe.source);

    return {
      violations: flatten(scan.results.violations, "violation", sanitizeUrl(frame.url()) || "", sanitizeUrl(pageUrl) || pageUrl, state, scan.documentToken),
      incomplete: flatten(scan.results.incomplete, "needs-review", sanitizeUrl(frame.url()) || "", sanitizeUrl(pageUrl) || pageUrl, state, scan.documentToken)
    };
  } catch (error) {
    return {
      violations: [],
      incomplete: [],
      limitation: `Frame could not be scanned: ${error.message}`
    };
  }
}

function flatten(rules, findingType, frameUrl, pageUrl, state, documentToken) {
  return rules.flatMap((rule) => rule.nodes.map((node, nodeIndex) => ({
    id: `${rule.id}-${hash(`${pageUrl}-${frameUrl}-${JSON.stringify(node.target)}-${nodeIndex}`)}`,
    findingType,
    ruleId: rule.id,
    impact: rule.impact || "moderate",
    help: rule.help,
    description: rule.description,
    helpUrl: rule.helpUrl,
    tags: rule.tags,
    wcag: criteriaFromTags(rule.tags),
    target: node.target,
    html: node.html,
    failureSummary: node.failureSummary || summarizeChecks(node),
    pageUrl,
    frameUrl,
    state,
    documentToken,
    evidence: null,
    source: "axe-core"
  })));
}

function summarizeChecks(node) {
  return [...(node.any || []), ...(node.all || []), ...(node.none || [])]
    .map((check) => check.message)
    .filter(Boolean)
    .join(" ");
}

function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}
