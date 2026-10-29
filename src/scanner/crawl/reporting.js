import { shortStateId } from "./identity.js";

export function finalizeCrawlGraph(report) {
  report.graph.nodes = report.pages.flatMap((page) => [{
      id: page.url,
      stateId: shortStateId(page.url),
      label: page.title || new URL(page.url).pathname || "/",
      url: page.url,
      depth: page.depth,
      issueCount: page.issueIds.length,
      status: page.error ? "failed" : page.crawlStatus || "scanned",
      terminationReason: page.terminationReason || null,
      state: "page",
      findingState: "default"
    }, ...page.observedStates]);
  report.graph.edges = report.graph.edges.filter((edge) => report.graph.nodes.some((node) => node.id === edge.target));
}

export function addEdge(report, keys, source, target, type, label = type, selector = null) {
  const key = `${source}|${target}|${type}|${label}`;
  if (source === target || keys.has(key)) return;
  keys.add(key);
  report.graph.edges.push({ source, target, type, label, selector });
}

export function countRecordedStates(report) {
  return report.pages.reduce((total, page) => total + 1 + (page.observedStates?.length || 0), 0);
}

export function summarize(report) {
  const byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const issue of report.issues) byImpact[issue.impact] = (byImpact[issue.impact] || 0) + 1;
  return {
    pagesScanned: report.pages.length,
    statesObserved: countRecordedStates(report),
    confirmedIssues: report.issues.length,
    needsReview: report.incomplete.length,
    bestPracticeFindings: (report.bestPractices || []).length,
    byImpact,
    sharedStatesReused: report.pages.reduce((sum, page) => sum + Number(page.interactionCoverage?.globalStatesReused || 0), 0),
    thirdPartyFramesSkipped: new Set(report.pages.flatMap((page) => page.skippedFrames || [])).size,
    documentsDiscovered: report.documents?.discovered.length || 0,
    documentsChecked: report.documents?.checked.length || 0,
    keyboardTraversalsCompleted: report.pages.filter((page) => page.keyboardCoverage?.completed).length,
    evidenceScreenshots: new Set([...report.issues, ...report.incomplete, ...(report.bestPractices || [])].map((finding) => finding.evidence || finding.contextEvidence).filter(Boolean)).size,
    blockersDetected: report.pages.reduce((sum, page) => sum + Number(page.blockerRecovery?.detected || 0), 0),
    blockersResolved: report.pages.reduce((sum, page) => sum + Number(page.blockerRecovery?.resolved || 0), 0),
    blockersRequiringUser: report.pages.reduce((sum, page) => sum + Number(page.blockerRecovery?.userActionRequired || 0), 0),
    accessibilityTreeStates: report.pages.reduce((sum, page) => sum + Number(page.screenReaderStates?.length || 0), 0),
    accessibilityTreeWarnings: report.pages.reduce((sum, page) => sum + (page.screenReaderStates || []).reduce((count, state) => count + Number(state.warnings?.length || 0), 0), 0),
    nvdaStatus: report.assistiveTechnology?.actualRuns?.NVDA?.status || "not-run",
    nvdaStatesExecuted: Number(report.assistiveTechnology?.actualRuns?.NVDA?.coverage?.statesExecuted || 0),
    nvdaAnnouncementsCaptured: Number(report.assistiveTechnology?.actualRuns?.NVDA?.coverage?.announcementsCaptured || 0),
    durationMs: Date.parse(report.completedAt) - Date.parse(report.startedAt),
    aiChecksUsed: report.events.filter((event) => event.type === "ai").length
  };
}

export function determineCrawlTermination(report, queue, config) {
  const blockersRequiringUser = report.pages.reduce((sum, page) => sum + Number(page.blockerRecovery?.userActionRequired || 0), 0);
  const visitedUrls = new Set(report.pages.flatMap((page) => [page.url, page.actualUrl]).filter(Boolean));
  const remainingRoutes = new Set([...queue.map((entry) => entry.url), ...report.pages.flatMap((page) => (page.skippedRoutes || []).map((entry) => entry.url))]
    .filter((url) => !visitedUrls.has(url))).size;
  const stateLimitReached = countRecordedStates(report) >= config.maxStates;
  const pageLimitReached = report.pages.length >= config.maxPages && remainingRoutes > 0;
  const limits = { remainingRoutes, blockersRequiringUser, pageLimitReached, stateLimitReached };
  if (stateLimitReached) return {
    reason: "state_limit_reached",
    message: `Crawl reached the configured ${config.maxStates}-state safety limit across ${report.pages.length} page${report.pages.length === 1 ? "" : "s"}, with ${remainingRoutes} eligible route${remainingRoutes === 1 ? "" : "s"} remaining.`,
    ...limits
  };
  if (pageLimitReached) return {
    reason: "page_limit_reached",
    message: `Crawl reached the configured ${config.maxPages}-page limit after inspecting ${countRecordedStates(report)} page and interaction states, with ${remainingRoutes} eligible route${remainingRoutes === 1 ? "" : "s"} remaining.`,
    ...limits
  };
  if (blockersRequiringUser) return {
    reason: "completed_with_blocked_branches",
    message: `Crawl completed its available queue, but ${blockersRequiringUser} blocking state${blockersRequiringUser === 1 ? "" : "s"} require user action. Other reachable branches continued.`,
    ...limits
  };
  if (report.pages.some((page) => page.interactionCoverage?.stateBudgetReached && page.interactionCoverage?.statesReservedForPages > 0)) return {
    reason: "interaction_budget_reserved",
    message: "The eligible page queue completed. Some interaction branches were limited to reserve state capacity for other pages.",
    ...limits
  };
  return {
    reason: "no_remaining_eligible_routes",
    message: "Crawl completed because no unvisited safe routes or interaction states remained.",
    ...limits
  };
}
