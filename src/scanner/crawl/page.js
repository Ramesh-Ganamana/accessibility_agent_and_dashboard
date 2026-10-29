import { resolveContextChooserIfPresent } from "../../browser/post-login.js";
import { storeDeduplicatedEvidence } from "../evidence.js";
import { collectTechnologyNotes, discoverNavigationActions } from "../discovery.js";
import { captureApplicationState, restoreActionPath } from "../actions.js";
import { scanKeyboardFocus } from "../focus.js";
import { scanVisualAdaptation } from "../adaptation.js";
import { scanMedia } from "../media.js";
import { collectDocumentLinks } from "../documents.js";
import { scanAltQuality } from "../vision.js";
import { detectPageAccessFailure } from "../../browser/readiness.js";
import { sanitizeUrlsInText } from "../../url-security.js";
import { actionExclusionsFor, isExcludedActionUrl } from "../../browser/action-exclusions.js";
import { createNvdaStateTarget } from "../../assistive-technology/state-targets.js";
import { testLiveNvdaState } from "./nvda-bridge.js";
import { scanCurrentState } from "./checks.js";
import { addReviewFindingsWithEvidence } from "./findings.js";
import { shortStateId, slug } from "./identity.js";
import { isSameSite, openScanTarget, cleanUrl, stableRestoreUrl, adoptRedirectedOrigin, applyExclusionsToLandingOrigin, isExcluded } from "./navigation.js";
import { exploreClickableStates } from "./interactions.js";

export async function scanPage({ page, session, url, replay, reuseCurrentPage, depth, outputDir, config, emit, report, issueKeys, incompleteKeys, edgeKeys, stateBudget, remainingPageSlots, pendingRoutes, knownPageUrls, getEvidenceIndex, evidenceRegistry, nvdaStateTargets, liveNvda, globalStates = new Map(), documentDownloads = new Map(), scanOpenedTab }) {
  const pageRecord = {
    url,
    title: "",
    depth,
    statusCode: null,
    loadMs: null,
    links: [],
    popupLinks: [],
    actualUrl: null,
    navigationActions: [],
    skippedRoutes: [],
    observedStates: [],
    stateEdges: [],
    issueIds: [],
    incompleteIds: [],
    bestPracticeIds: [],
    skippedFrames: [],
    interactionCoverage: { candidatesFound: 0, actionsAttempted: 0, statesDiscovered: 0, routesDiscovered: 0, restoreFailures: 0 },
    blockerRecovery: { detected: 0, resolved: 0, userActionRequired: 0, records: [] },
    screenReaderStates: [],
    ruleOutcomes: [],
    crawlStatus: "scanned",
    terminationReason: null,
    technology: {},
    baseline: null,
    error: null
  };
  // Reserve this page and its base state before visiting child tabs, so nested
  // tabs share the same limits and the original page stays first in the report.
  report.pages.push(pageRecord);
  const pageOrdinal = report.pages.length;
  const loadStart = Date.now();

  try {
    const response = await openScanTarget({ page, url, replay, reuseCurrentPage, emit, config });
    // The list must cover the landing page before any helper clicks on it.
    if (pageOrdinal === 1) await applyExclusionsToLandingOrigin({ session, config, report, emit, url: page.url() });
    await resolveContextChooserIfPresent(page, config, emit, { appearanceTimeout: config.login?.postLoginValue ? 3_000 : 0 });
    pageRecord.statusCode = response?.status() ?? null;
    pageRecord.actualUrl = cleanUrl(page.url()) || url;
    knownPageUrls.add(pageRecord.actualUrl);
    if (pageOrdinal === 1) {
      adoptRedirectedOrigin(report, config, pageRecord.actualUrl, emit);
      await applyExclusionsToLandingOrigin({ session, config, report, emit, url: page.url() });
    }
    if (isExcludedActionUrl(page.url(), actionExclusionsFor(config, page.url()))) {
      throw new Error("The page opened at an address on the application's Do not click list; it was not scanned or used.");
    }
    const accessFailure = await detectPageAccessFailure(page);
    if (accessFailure) throw new Error(`The application returned “${accessFailure}” while the crawler opened this protected route. The route was not evaluated and no findings were created from the error page.`);
    pageRecord.loadMs = Date.now() - loadStart;
    pageRecord.title = await page.title();
    pageRecord.technology = await collectTechnologyNotes(page);
    let baseNvdaTarget;
    if (config.nvda?.requested) {
      baseNvdaTarget = {
        id: url, stateId: shortStateId(url), state: "default", url: pageRecord.actualUrl, pageUrl: url,
        title: pageRecord.title, snapshot: await captureApplicationState(page),
        replay: replay || { baseUrl: stableRestoreUrl(pageRecord.actualUrl, url), path: [] }
      };
      if (config.nvdaRunner || config.nvdaCollectTargets) nvdaStateTargets.push(createNvdaStateTarget(baseNvdaTarget));
    }

    const baselineName = `${String(pageOrdinal).padStart(3, "0")}-${slug(pageRecord.title || new URL(url).pathname || "home")}.png`;
    const baselineBuffer = await page.screenshot({ fullPage: false });
    pageRecord.baseline = (await storeDeduplicatedEvidence({
      outputDir,
      relativeDir: "evidence/baselines",
      fileName: baselineName,
      buffer: baselineBuffer,
      registry: evidenceRegistry
    })).path;

    await scanCurrentState({ page, url, state: "default", outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex, evidenceRegistry, config });

    const baseNvda = await testLiveNvdaState({ liveNvda, page, target: baseNvdaTarget, report, emit });
    if (baseNvda?.stateChanged) {
      pageRecord.nvdaStateChanged = true;
      const restored = await restoreActionPath(page, baseNvdaTarget.replay.baseUrl, baseNvdaTarget.replay.path || [], {
        expectedRootFingerprint: baseNvdaTarget.replay.rootFingerprint || (!baseNvdaTarget.replay.path?.length ? baseNvdaTarget.snapshot.fingerprint : undefined)
      });
      if (!restored) {
        pageRecord.crawlStatus = "blocked";
        pageRecord.terminationReason = "nvda_state_changed_restore_failed";
        return pageRecord;
      }
    }

    const keyboardCoverage = {};
    const focusFindings = await scanKeyboardFocus(page, url, config.keyboardMaxTabs ?? 120, { coverage: (value) => Object.assign(keyboardCoverage, value) });
    pageRecord.keyboardCoverage = keyboardCoverage;
    await addReviewFindingsWithEvidence({ findings: focusFindings, page, frame: page.mainFrame(), outputDir, report, pageRecord, incompleteKeys, getEvidenceIndex, evidenceRegistry });

    // Zoom, reflow and text spacing. A shared NVDA window (viewport null) is not resized.
    const adaptation = await scanVisualAdaptation(page, url, { canResize: Boolean(page.viewportSize()), outputDir, evidenceRegistry, nextEvidenceIndex: getEvidenceIndex });
    for (const note of adaptation.skipped) if (!report.limitations.includes(note)) report.limitations.push(note);
    await addReviewFindingsWithEvidence({ findings: adaptation.findings, page, frame: page.mainFrame(), outputDir, report, pageRecord, incompleteKeys, getEvidenceIndex, evidenceRegistry });

    const mediaFindings = await scanMedia(page, url);
    await addReviewFindingsWithEvidence({ findings: mediaFindings, page, frame: page.mainFrame(), outputDir, report, pageRecord, incompleteKeys, getEvidenceIndex, evidenceRegistry });
    // PDFs and office documents linked from this page are checked after the crawl.
    await collectDocumentLinks(page, report, (href) => isSameSite(href, report.targetUrl), documentDownloads, { excludeLabels: actionExclusionsFor(config, page.url()) });

    const visionFindings = await scanAltQuality(page, url, config, emit);
    await addReviewFindingsWithEvidence({ findings: visionFindings, page, frame: page.mainFrame(), outputDir, report, pageRecord, incompleteKeys, getEvidenceIndex, evidenceRegistry });

    pageRecord.navigationActions = await discoverNavigationActions(page, report.targetUrl, { excludeLabels: actionExclusionsFor(config, page.url()) });
    const interactiveRoutes = await exploreClickableStates({
      page,
      session,
      config,
      url,
      restoreUrl: stableRestoreUrl(pageRecord.actualUrl, url),
      depth,
      maxDepth: config.maxDepth,
      maxStates: Math.max(0, stateBudget - 1),
      remainingPageSlots,
      reservedRoutes: new Set([...pendingRoutes, ...pageRecord.navigationActions
        .filter((action) => depth < config.maxDepth && !isExcluded(action.url, config.excludePaths) && !knownPageUrls.has(action.url))
        .map((action) => action.url)]),
      knownPageUrls,
      outputDir,
      report,
      pageRecord,
      issueKeys,
      incompleteKeys,
      getEvidenceIndex,
      evidenceRegistry,
      emit,
      entryReplay: replay,
      nvdaStateTargets,
      liveNvda,
      globalStates,
      scanOpenedTab
    });
    pageRecord.navigationActions.push(...interactiveRoutes);
    pageRecord.links = [...new Set(pageRecord.navigationActions.filter((action) => !action.popup).map((action) => action.url))];
    pageRecord.popupLinks = [...new Set(pageRecord.navigationActions.filter((action) => action.popup).map((action) => action.url))];
  } catch (error) {
    if (error?.code === "NVDA_INTERRUPTED") throw error;
    pageRecord.loadMs = Date.now() - loadStart;
    pageRecord.error = sanitizeUrlsInText(error.message);
    emit({ type: "page-error", message: error.message, url });
  }
  return pageRecord;
}
