const CROSS_SITE_MESSAGE = "Cross-site report comparison is not allowed. Choose a scan from the same application.";

export function reportDomain(report) {
  try { return new URL(report?.targetUrl).hostname.toLowerCase(); } catch { return ""; }
}

export function compareReports(current, previous) {
  const currentDomain = reportDomain(current);
  if (!currentDomain || currentDomain !== reportDomain(previous)) {
    const error = new Error(CROSS_SITE_MESSAGE);
    error.status = 409;
    throw error;
  }
  if (!current?.completedAt || !previous?.completedAt || current.id === previous.id) {
    const error = new Error("Choose two different completed scans to compare.");
    error.status = 400;
    throw error;
  }
  const previousStart = Date.parse(previous.startedAt);
  const currentStart = Date.parse(current.startedAt);
  if (!Number.isFinite(previousStart) || !Number.isFinite(currentStart) || previousStart >= currentStart) {
    const error = new Error("Choose a scan older than the current report.");
    error.status = 400;
    throw error;
  }

  const currentCoverage = scannedSurfaces(current);
  const previousCoverage = scannedSurfaces(previous);
  const currentFindings = indexFindings(current);
  const previousFindings = indexFindings(previous);
  const currentUncertain = uncertainSurfaces(current);
  const previousUncertain = uncertainSurfaces(previous);
  const groups = { new: [], fixed: [], unresolved: [] };
  let excludedForCoverage = 0;
  let excludedForReview = 0;

  for (const [key, finding] of currentFindings) {
    if (previousFindings.has(key)) {
      groups.unresolved.push({ ...finding, previousEvidence: previousFindings.get(key).evidence });
    } else if (!previousCoverage.has(finding.surface)) {
      excludedForCoverage += 1;
    } else if (previousUncertain.has(finding.reviewKey)) {
      excludedForReview += 1;
    } else {
      groups.new.push({ ...finding, previousEvidence: pageContextEvidence(previous, finding.pageUrl) });
    }
  }
  for (const [key, finding] of previousFindings) {
    if (currentFindings.has(key)) continue;
    if (!currentCoverage.has(finding.surface)) excludedForCoverage += 1;
    else if (currentUncertain.has(finding.reviewKey)) excludedForReview += 1;
    else groups.fixed.push({ ...finding, currentEvidence: pageContextEvidence(current, finding.pageUrl) });
  }
  for (const entries of Object.values(groups)) entries.sort(sortFindings);

  return {
    domain: currentDomain,
    current: { id: current.id, completedAt: current.completedAt },
    previous: { id: previous.id, completedAt: previous.completedAt },
    graphs: {
      previous: comparisonGraph(previous),
      current: comparisonGraph(current)
    },
    counts: Object.fromEntries(Object.entries(groups).map(([group, entries]) => [group, entries.length])),
    excludedForCoverage,
    excludedForReview,
    groups
  };
}

function comparisonGraph(report) {
  const nodes = (report.graph?.nodes || []).map((node) => ({
    id: String(node.id || ""), label: String(node.label || ""), url: String(node.url || ""),
    depth: Number(node.depth || 0), status: String(node.status || "scanned"),
    issueCount: Number(node.issueCount || 0), state: String(node.state || "page")
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (report.graph?.edges || [])
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target, type: String(edge.type || "navigate"), label: String(edge.label || edge.type || "navigate") }));
  return { nodes, edges };
}

function indexFindings(report) {
  const findings = new Map();
  for (const issue of report.issues || []) {
    const target = formatTarget(issue.target);
    const ruleId = String(issue.ruleId || "").trim();
    // A shared header/navigation finding is recorded once with the other pages
    // listed; compare it on every page where it was observed.
    const occurrences = [{ pageUrl: issue.pageUrl || report.targetUrl, state: issue.state }, ...(Array.isArray(issue.alsoObservedOn) ? issue.alsoObservedOn : [])];
    for (const occurrence of occurrences) {
      const pageUrl = occurrence.pageUrl || report.targetUrl;
      const page = routeKey(pageUrl);
      const state = String(occurrence.state || "default").trim();
      // A main-frame finding's frame is the page it was observed on.
      const mainFrame = !issue.frameUrl || locationKey(issue.frameUrl) === locationKey(issue.pageUrl || report.targetUrl);
      const frameUrl = mainFrame ? pageUrl : issue.frameUrl;
      for (const criterion of issue.wcag || []) {
        if (!/^\d+\.\d+\.\d+$/.test(String(criterion))) continue;
        const surface = surfaceKey(locationKey(pageUrl), state);
        const frame = locationKey(frameUrl);
        const reviewKey = `${surface}\u0000${frame}\u0000${criterion}\u0000${ruleId}`;
        const key = `${reviewKey}\u0000${target}`;
        if (!findings.has(key)) findings.set(key, {
          criterion, ruleId, help: issue.help || ruleId, target, page, pageUrl, state,
          surface, reviewKey, evidence: evidenceReference(report.id, issue) || pageContextEvidence(report, pageUrl)
        });
      }
    }
  }
  return findings;
}

function evidenceReference(reportId, issue) {
  const file = issue.evidence || issue.contextEvidence;
  if (!/^[a-zA-Z0-9_-]+$/.test(String(reportId || "")) ||
      !/^evidence\/(?:baselines\/)?[a-zA-Z0-9._-]+\.(?:png|jpe?g|webp)$/i.test(String(file || ""))) return null;
  return {
    url: `/reports/${encodeURIComponent(reportId)}/${file}`,
    kind: issue.evidenceKind || (issue.evidence ? "highlighted" : "page-context")
  };
}

function pageContextEvidence(report, pageUrl) {
  const page = (report.pages || []).find((entry) => !entry.error && samePageLocation(entry.url, pageUrl) &&
    (!entry.actualUrl || samePageLocation(entry.url, entry.actualUrl)) && entry.baseline);
  return page ? evidenceReference(report.id, { contextEvidence: page.baseline, evidenceKind: "page-context" }) : null;
}

function samePageLocation(requested, actual) {
  try {
    const first = new URL(requested);
    const second = new URL(actual);
    return first.origin === second.origin && routeKey(first.href) === routeKey(second.href);
  } catch { return false; }
}

function scannedSurfaces(report) {
  const surfaces = new Set();
  for (const page of report.pages || []) {
    if (page.error) continue;
    // Redirected authentication/error pages do not establish coverage of the requested route.
    if (page.actualUrl && !samePageLocation(page.url, page.actualUrl)) continue;
    const route = locationKey(page.url);
    surfaces.add(surfaceKey(route, "default"));
    for (const observed of page.observedStates || []) {
      const state = `${observed.state}:${String(observed.label || "").slice(0, 60)}`;
      surfaces.add(surfaceKey(route, state));
    }
  }
  return surfaces;
}

function uncertainSurfaces(report) {
  const uncertain = new Set();
  for (const issue of report.incomplete || []) {
    const pageUrl = issue.pageUrl || report.targetUrl;
    const surface = surfaceKey(locationKey(pageUrl), issue.state || "default");
    const frame = locationKey(issue.frameUrl || pageUrl);
    for (const criterion of issue.wcag || []) {
      uncertain.add(`${surface}\u0000${frame}\u0000${criterion}\u0000${String(issue.ruleId || "").trim()}`);
    }
  }
  return uncertain;
}

function surfaceKey(page, state) {
  const value = String(state || "default").trim();
  // Keyboard traversal is part of each successfully scanned page, not a graph node.
  return `${page}\u0000${/^keyboard-/i.test(value) ? "default" : value}`;
}

function routeKey(value) {
  try {
    const url = new URL(value);
    const hashRoute = /^#(?:!\/|\/)/.test(url.hash) ? url.hash : "";
    return `${url.pathname || "/"}${url.search}${hashRoute}`;
  } catch { return String(value || ""); }
}

function locationKey(value) {
  try { return `${new URL(value).origin}${routeKey(value)}`; }
  catch { return String(value || ""); }
}

function formatTarget(target) {
  return (Array.isArray(target) ? target.flat(Infinity) : [target])
    .map((part) => String(part || "").replace(/\s+/g, " ").trim())
    .filter(Boolean).join(" → ") || "Unknown element";
}

function sortFindings(a, b) {
  return a.criterion.localeCompare(b.criterion, undefined, { numeric: true })
    || a.page.localeCompare(b.page)
    || a.target.localeCompare(b.target);
}
