import axe from "axe-core";
import { criteriaFromTags } from "./wcag.js";
import { sanitizeUrl } from "../url-security.js";

export async function scanFrameWithAxe(frame, pageUrl, state = "default", audit = {}) {
  const wcagVersion = audit.wcagVersion === "2.1" ? "2.1" : "2.2";
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice", ...(wcagVersion === "2.2" ? ["wcag22a", "wcag22aa"] : [])];
  try {
    const scan = await frame.evaluate(async ({ source, tags }) => {
      if (!globalThis.axe) (0, eval)(source);
      globalThis.__clarityDocumentToken ||= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const results = await globalThis.axe.run(document, {
        runOnly: { type: "tag", values: tags },
        resultTypes: ["violations", "incomplete", "passes", "inapplicable"],
        reporter: "v2",
        // Playwright scans every frame independently below. Prevent axe from
        // attempting to reach through a parent frame's cross-origin boundary.
        iframes: false
      });
      // Shared header/navigation/footer nodes repeat on every page of a site.
      const regionOf = (target) => {
        try {
          if (!Array.isArray(target) || target.length !== 1 || typeof target[0] !== "string") return "main";
          const shared = document.querySelector(target[0])?.closest('header,nav,footer,[role="banner"],[role="navigation"],[role="contentinfo"]');
          if (!shared || shared.closest('main,[role="main"],[role="dialog"],dialog,[aria-modal="true"]')) return "main";
          return "global";
        } catch { return "main"; }
      };
      for (const key of ["violations", "incomplete"]) for (const rule of results[key]) for (const node of rule.nodes) node.region = regionOf(node.target);
      // Passing DOM snapshots can contain private application data. Persist
      // only aggregate rule observations, not their node markup or values.
      const outcomes =Object.entries({ violations: "fail", incomplete: "needs-review", passes: "pass", inapplicable: "inapplicable" })
        .flatMap(([key, status]) => results[key].map((rule) => ({ id: rule.id, status, tags: rule.tags, nodeCount: rule.nodes.length })));
      return { results: { violations: results.violations, incomplete: results.incomplete }, outcomes, engineVersion: globalThis.axe.version, documentToken: globalThis.__clarityDocumentToken };
    }, { source: axe.source, tags });

    return {
      violations: flatten(scan.results.violations, "violation", sanitizeUrl(frame.url()) || "", sanitizeUrl(pageUrl) || pageUrl, state, scan.documentToken),
      incomplete: flatten(scan.results.incomplete, "needs-review", sanitizeUrl(frame.url()) || "", sanitizeUrl(pageUrl) || pageUrl, state, scan.documentToken),
      testOutcomes: {
        state, frameUrl: sanitizeUrl(frame.url()) || "", engine: "axe-core", engineVersion: scan.engineVersion, wcagVersion,
        rules: scan.outcomes.map((rule) => ({ ...rule, wcag: criteriaFromTags(rule.tags) }))
      }
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
    // The crawler's own temporary marker attributes are not application markup.
    html: String(node.html || "").replace(/\s(?:data-clarity-action-key|data-a11y-[a-z-]+|data-rambo-[a-z-]+)="[^"]*"/g, ""),
    region: node.region === "global" ? "global" : "main",
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
