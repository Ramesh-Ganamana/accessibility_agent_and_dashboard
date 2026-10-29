import { inspectApplicationTab } from "../../browser/tabs.js";
import { writeReportCheckpoint } from "../../report/export.js";
import { actionExclusionsFor, isExcludedActionUrl } from "../../browser/action-exclusions.js";
import { addEdge, countRecordedStates } from "./reporting.js";
import { scanPage } from "./page.js";
import { cleanUrl, isExcluded } from "./navigation.js";

// Owns route discovery, replay upgrades, and application-created tab visits.
// Session and reader accessors are evaluated only when a tab is visited.
export function createCrawlQueue({ startUrl, config, report, maxStates, outputDir, emit,
  issueKeys, incompleteKeys, edgeKeys, evidenceRegistry, nvdaStateTargets, globalStates,
  documentDownloads, getEvidenceIndex, getSession, getLiveNvda }) {
  const queue = [{ url: startUrl, depth: 0, parent: null, relation: "start", replay: null }];
  const queued = new Set([startUrl]);
  const visited = new Set();
  function recordDiscoveredRoutes(pageRecord, item) {
    for (const action of pageRecord.navigationActions) {
      const type = action.type || (action.popup ? "popup" : "navigate");
      const source = action.source || item.url;
      const actionDepth = Number(action.depth ?? item.depth + 1);
      // A listed link or page address is never queued, however it was reached.
      if (isExcludedActionUrl(action.url, actionExclusionsFor(config, action.url))) {
        emit({ type: "action-skip", message: "A route on the Do not click list was not opened.", url: action.url });
        delete action._replay;
        continue;
      }
      addEdge(report, edgeKeys, source, action.url, type, action.edgeLabel || `${type}: ${action.label}`, action.selector);
      if (actionDepth <= config.maxDepth && !isExcluded(action.url, config.excludePaths)) {
        const pending = queue.find((entry) => entry.url === action.url);
        if (pending && action._replay && !pending.replay) pending.replay = action._replay;
        if (!queued.has(action.url)) {
          queued.add(action.url);
          queue.push({ url: action.url, depth: actionDepth, parent: source, relation: type, replay: action._replay || null });
        }
      }
      delete action._replay;
    }
    for (const edge of pageRecord.stateEdges) addEdge(report, edgeKeys, edge.source, edge.target, edge.type, edge.label, edge.selector);
  }

  const scanOpenedTab = async ({ opener, popup, source, depth, label = "opened tab", selector, type = "popup" }) => {
    const session = getSession();
    const liveNvda = getLiveNvda();
    const popupUrl = cleanUrl(popup.url());
    try {
      return await inspectApplicationTab({ opener, popup, applicationUrl: report.targetUrl, nvda: liveNvda, emit,
        visit: async (tab, tabNvda) => {
          if (!popupUrl || isExcluded(popupUrl, config.excludePaths)) return { status: "skipped", reason: "excluded-route" };
          if (isExcludedActionUrl(popup.url(), actionExclusionsFor(config, popup.url()))) return { status: "skipped", reason: "user-excluded-action" };
          addEdge(report, edgeKeys, source, popupUrl, type, `${type}: ${label}`, selector);
          if (visited.has(popupUrl)) return { status: "skipped", reason: "already-scanned" };
          const reason = depth > config.maxDepth ? "depth_limit_reached"
            : report.pages.length >= config.maxPages ? "page_limit_reached"
            : countRecordedStates(report) >= maxStates ? "state_limit_reached" : null;
          if (reason) {
            emit({ type: "action-skip", message: `The new tab was not scanned because ${reason.replaceAll("_", " ")}.`, url: popupUrl });
            return { status: "skipped", reason };
          }
          visited.add(popupUrl);
          queued.add(popupUrl);
          for (let index = queue.length - 1; index >= 0; index--) if (queue[index].url === popupUrl) queue.splice(index, 1);
          emit({ type: "progress", message: `Scanning new application tab ${popupUrl}`, current: report.pages.length + 1, total: config.maxPages, url: popupUrl });
          const record = await scanPage({
            page: tab, session: { ...session, page: tab }, url: popupUrl, reuseCurrentPage: true, depth,
            outputDir, config, emit, report, issueKeys, incompleteKeys, edgeKeys,
            stateBudget: Math.max(1, maxStates - countRecordedStates(report)),
            remainingPageSlots: Math.max(0, config.maxPages - report.pages.length - 1),
            pendingRoutes: queue.map((entry) => entry.url),
            knownPageUrls: new Set([...report.pages.flatMap((entry) => [entry.url, entry.actualUrl]), popupUrl].filter(Boolean)),
            getEvidenceIndex, evidenceRegistry, nvdaStateTargets, liveNvda: tabNvda,
            globalStates, documentDownloads, scanOpenedTab
          });
          record.openedFrom = { url: source, label, type: "tab" };
          recordDiscoveredRoutes(record, { url: popupUrl, depth });
          await writeReportCheckpoint(report, outputDir).catch(() => {});
          return { status: record.error ? "failed" : "scanned", reason: record.error || null };
        }
      });
    } finally { session.popupPages.delete(popup); }
  };

  return { queue, queued, visited, recordDiscoveredRoutes, scanOpenedTab };
}
