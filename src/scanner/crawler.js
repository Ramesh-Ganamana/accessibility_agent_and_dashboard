import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createBrowserSession, ensureAuthenticated, isLoginSurface } from "../browser/session.js";
import { resolveContextChooserIfPresent } from "../browser/post-login.js";
import { scanFrameWithAxe } from "./axe.js";
import { captureHighlightedEvidence } from "./evidence.js";
import { collectTechnologyNotes, discoverNavigationActions } from "./discovery.js";
import { captureApplicationState, clickSafeAction, inventorySafeActions, restoreActionPath } from "./actions.js";
import { scanKeyboardFocus } from "./focus.js";
import { scanAltQuality } from "./vision.js";
import { writeReportFiles } from "../report/export.js";
import { detectPageAccessFailure, navigateAndWait, waitForPageReady } from "../browser/readiness.js";
import { sanitizeUrl, sanitizeUrlsInText } from "../url-security.js";
import { attemptAiGroundedAction } from "./ai-grounding.js";

export async function runAccessibilityScan(config, onEvent = () => {}) {
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
  const outputDir = path.join(config.reportsDir, runId);
  await fs.mkdir(path.join(outputDir, "evidence", "baselines"), { recursive: true });

  const startUrl = validateTarget(config.targetUrl);
  const report = {
    id: runId,
    targetUrl: startUrl,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    configuration: {
      maxPages: config.maxPages,
      maxDepth: config.maxDepth,
      aiEnabled: config.aiEnabled,
      headless: config.headless,
      interactionCrawl: true,
      excludedActionLabels: config.excludeActionLabels,
      excludedActionOrigin: config.excludeActionOrigin,
      actionPolicy: "safe-clicks-with-destructive-and-form-submit-exclusions"
    },
    summary: {},
    pages: [],
    graph: { nodes: [], edges: [] },
    issues: [],
    incomplete: [],
    events: [],
    limitations: [
      "Closed Shadow DOM internals cannot be inspected by browser automation or injected page scripts.",
      "Cross-origin frames are attempted independently; browser/site policy, authentication, or frame detachment can still prevent a complete scan.",
      "Clickable controls without a usable label, disabled or covered controls, mutating form controls, and destructive actions are not invoked automatically.",
      "Automated testing cannot prove full WCAG conformance; manual assistive-technology review remains necessary."
    ]
  };

  const emit = (event) => {
    const enriched = {
      at: new Date().toISOString(),
      ...event,
      ...(event.message ? { message: sanitizeUrlsInText(event.message) } : {}),
      ...(event.url ? { url: sanitizeUrl(event.url) || undefined } : {})
    };
    report.events.push(enriched);
    onEvent(enriched);
  };

  const session = await createBrowserSession(config, emit);
  const queue = [{ url: startUrl, depth: 0, parent: null, relation: "start", replay: null }];
  const queued = new Set([startUrl]);
  const visited = new Set();
  const issueKeys = new Set();
  const incompleteKeys = new Set();
  const edgeKeys = new Set();
  let evidenceCount = 0;

  try {
    const authenticated = await ensureAuthenticated(session, config, emit);
    let reuseAuthenticatedPage = authenticated && sameOrigin(startUrl, session.page.url());

    while (queue.length && countRecordedStates(report) < config.maxPages) {
      const item = queue.shift();
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      emit({ type: "progress", message: `Scanning ${item.url}`, current: report.pages.length + 1, total: config.maxPages, url: item.url });

      const pageRecord = await scanPage({
        page: session.page,
        session,
        url: item.url,
        replay: item.replay,
        reuseCurrentPage: reuseAuthenticatedPage && item.depth === 0,
        depth: item.depth,
        outputDir,
        config,
        emit,
        report,
        issueKeys,
        incompleteKeys,
        edgeKeys,
        stateBudget: Math.max(1, config.maxPages - countRecordedStates(report)),
        getEvidenceIndex: () => ++evidenceCount
      });
      reuseAuthenticatedPage = false;
      report.pages.push(pageRecord);

      for (const action of pageRecord.navigationActions) {
        const type = action.type || (action.popup ? "popup" : "navigate");
        const source = action.source || item.url;
        const actionDepth = Number(action.depth ?? item.depth + 1);
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

      for (const stateEdge of pageRecord.stateEdges) addEdge(report, edgeKeys, stateEdge.source, stateEdge.target, stateEdge.type, stateEdge.label, stateEdge.selector);

      for (const popup of [...session.popupPages]) {
        if (popup === session.page || popup.isClosed()) continue;
        const popupUrl = cleanUrl(popup.url());
        if (popupUrl && sameOrigin(startUrl, popupUrl)) {
          addEdge(report, edgeKeys, item.url, popupUrl, "popup", "popup: opened window");
          if (!queued.has(popupUrl) && item.depth < config.maxDepth) {
            queued.add(popupUrl);
            queue.push({ url: popupUrl, depth: item.depth + 1, parent: item.url, relation: "popup" });
          }
        }
        await popup.close().catch(() => {});
        session.popupPages.delete(popup);
      }
    }

    report.completedAt = new Date().toISOString();
    report.graph.nodes = report.pages.flatMap((page) => [{
      id: page.url,
      stateId: shortStateId(page.url),
      label: page.title || new URL(page.url).pathname || "/",
      url: page.url,
      depth: page.depth,
      issueCount: page.issueIds.length,
      status: page.error ? "failed" : "scanned",
      state: "page"
    }, ...page.observedStates]);
    report.graph.edges = report.graph.edges.filter((edge) => report.graph.nodes.some((node) => node.id === edge.target));
    report.summary = summarize(report);
    await writeReportFiles(report, outputDir);
    emit({ type: "complete", message: `Scan completed with ${report.issues.length} confirmed findings and ${report.incomplete.length} items requiring review.`, reportId: runId });
    return report;
  } finally {
    await session.close().catch(() => {});
  }
}

async function scanPage({ page, session, url, replay, reuseCurrentPage, depth, outputDir, config, emit, report, issueKeys, incompleteKeys, edgeKeys, stateBudget, getEvidenceIndex }) {
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
    observedStates: [],
    stateEdges: [],
    issueIds: [],
    incompleteIds: [],
    interactionCoverage: { candidatesFound: 0, actionsAttempted: 0, statesDiscovered: 0, routesDiscovered: 0, restoreFailures: 0 },
    technology: {},
    baseline: null,
    error: null
  };
  const loadStart = Date.now();

  try {
    const response = await openScanTarget({ page, url, replay, reuseCurrentPage, emit });
    await resolveContextChooserIfPresent(page, config, emit, { appearanceTimeout: config.login?.postLoginValue ? 3_000 : 0 });
    pageRecord.statusCode = response?.status() ?? null;
    pageRecord.actualUrl = cleanUrl(page.url()) || url;
    const accessFailure = await detectPageAccessFailure(page);
    if (accessFailure) throw new Error(`The application returned “${accessFailure}” while the crawler opened this protected route. The route was not evaluated and no findings were created from the error page.`);
    pageRecord.loadMs = Date.now() - loadStart;
    pageRecord.title = await page.title();
    pageRecord.technology = await collectTechnologyNotes(page);

    const baselineName = `${String(report.pages.length + 1).padStart(3, "0")}-${slug(pageRecord.title || new URL(url).pathname || "home")}.png`;
    await page.screenshot({ path: path.join(outputDir, "evidence", "baselines", baselineName), fullPage: false });
    pageRecord.baseline = `evidence/baselines/${baselineName}`;

    await scanCurrentState({ page, url, state: "default", outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex });

    const focusFindings = await scanKeyboardFocus(page, url);
    await addFindingsWithEvidence({ findings: focusFindings, page, frame: page.mainFrame(), outputDir, report, pageRecord, issueKeys, getEvidenceIndex });

    const visionFindings = await scanAltQuality(page, url, config, emit);
    await addFindingsWithEvidence({ findings: visionFindings, page, frame: page.mainFrame(), outputDir, report, pageRecord, issueKeys, getEvidenceIndex });

    pageRecord.navigationActions = await discoverNavigationActions(page, report.targetUrl);
    const interactiveRoutes = await exploreClickableStates({
      page,
      session,
      config,
      url,
      restoreUrl: stableRestoreUrl(pageRecord.actualUrl, url),
      depth,
      maxDepth: config.maxDepth,
      maxStates: Math.max(0, stateBudget - 1),
      outputDir,
      report,
      pageRecord,
      issueKeys,
      incompleteKeys,
      getEvidenceIndex,
      emit,
      entryReplay: replay
    });
    pageRecord.navigationActions.push(...interactiveRoutes);
    pageRecord.links = [...new Set(pageRecord.navigationActions.filter((action) => !action.popup).map((action) => action.url))];
    pageRecord.popupLinks = [...new Set(pageRecord.navigationActions.filter((action) => action.popup).map((action) => action.url))];
  } catch (error) {
    pageRecord.loadMs = Date.now() - loadStart;
    pageRecord.error = sanitizeUrlsInText(error.message);
    emit({ type: "page-error", message: error.message, url });
  }
  return pageRecord;
}

async function scanCurrentState({ page, url, state, outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex }) {
  const accessFailure = await detectPageAccessFailure(page);
  if (accessFailure) {
    report.limitations.push(`${url} (${state}): application returned ${accessFailure}; this state was not evaluated.`);
    return;
  }
  for (const frame of page.frames()) {
    const result = await scanFrameWithAxe(frame, url, state);
    if (result.limitation) report.limitations.push(`${frame.url() || "unnamed frame"}: ${result.limitation}`);
    await addFindingsWithEvidence({ findings: result.violations, page, frame, outputDir, report, pageRecord, issueKeys, getEvidenceIndex });
    for (const finding of result.incomplete) {
      const key = findingKey(finding);
      if (incompleteKeys.has(key)) continue;
      incompleteKeys.add(key);
      finding.reviewStatus = "needs-review";
      finding.reviewHistory = [{
        at: new Date().toISOString(),
        status: "needs-review",
        source: finding.source || "axe-core",
        message: finding.failureSummary || finding.description || "Automated evaluation could not determine a definitive pass or failure."
      }];
      if (report.incomplete.length < 80) {
        finding.evidence = await captureHighlightedEvidence({
          page,
          frame,
          target: finding.target,
          issue: finding,
          outputDir,
          index: getEvidenceIndex()
        });
      }
      finding.evidenceKind = finding.evidence ? "highlighted" : "unavailable";
      if (!finding.evidence && state === "default" && pageRecord.baseline) {
        finding.contextEvidence = pageRecord.baseline;
        finding.evidenceKind = "page-context";
      }
      report.incomplete.push(finding);
      pageRecord.incompleteIds.push(finding.id);
    }
  }
}

async function addFindingsWithEvidence({ findings, page, frame, outputDir, report, pageRecord, issueKeys, getEvidenceIndex }) {
  for (const finding of findings) {
    const key = findingKey(finding);
    if (issueKeys.has(key)) continue;
    issueKeys.add(key);
    if (report.issues.length < 80) {
      finding.evidence = await captureHighlightedEvidence({
        page,
        frame,
        target: finding.target,
        issue: finding,
        outputDir,
        index: getEvidenceIndex()
      });
    }
    report.issues.push(finding);
    pageRecord.issueIds.push(finding.id);
  }
}

async function exploreClickableStates({ page, session, config, url, restoreUrl, depth, maxDepth, maxStates, outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex, emit, entryReplay }) {
  if (maxStates <= 0 || depth >= maxDepth) return [];
  await resolveContextChooserIfPresent(page, config, emit);
  const initial = await captureApplicationState(page);
  const replayRoot = entryReplay || { baseUrl: restoreUrl, rootFingerprint: initial.fingerprint, path: [] };
  const knownStates = new Map([[initial.fingerprint, url]]);
  const routeActions = [];
  const routeTargets = new Set();
  const work = [{ nodeId: url, path: [], depth }];
  let useCurrentRootState = true;
  const aiAttemptedStates = new Set();
  const candidateSignatures = new Set();
  const attemptedSignatures = new Set();
  let restoreFailures = 0;
  let restoreWarningEmitted = false;
  const restore = async (path) => {
    const restored = await restoreActionPath(page, replayRoot.baseUrl, [...replayRoot.path, ...path], { expectedRootFingerprint: replayRoot.rootFingerprint });
    if (!restored) {
      restoreFailures += 1;
      if (!restoreWarningEmitted) {
        restoreWarningEmitted = true;
        const message = "The application could not safely restore a previous application state after navigation or authentication. The affected branch was skipped while the rest of the scan continued.";
        emit({ type: "crawl-warning", message, url: page.url() });
        report.limitations.push(message);
      }
    }
    return restored;
  };

  while (work.length && pageRecord.observedStates.length + routeTargets.size < maxStates) {
    const current = work.shift();
    const currentStateIsAlreadyOpen = useCurrentRootState && current.path.length === 0;
    if (!currentStateIsAlreadyOpen && !(await restore(current.path))) continue;
    await resolveContextChooserIfPresent(page, config, emit);
    const actions = await inventorySafeActions(page, { excludeLabels: actionExclusionsForPage(config, page.url()) });
    actions.forEach((action) => candidateSignatures.add(action.signature));
    const progressBefore = pageRecord.observedStates.length + routeTargets.size;
    const stalledSince = Date.now();
    useCurrentRootState = false;
    const remainingCapacity = Math.max(0, maxStates - progressBefore);
    emit({ type: "actions", message: `Found ${actions.length} safe clickable candidates in state ${shortStateId(current.nodeId)}; ${remainingCapacity} new states or routes remain within the configured limit.`, url });

    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex];
      if (pageRecord.observedStates.length + routeTargets.size >= maxStates) break;
      const canUseOpenState = currentStateIsAlreadyOpen && actionIndex === 0;
      if (!canUseOpenState && !(await restore(current.path))) {
        emit({ type: "action-skip", message: `Skipped “${action.label}” because its parent application state could not be restored within 50 seconds; continuing with the remaining controls.`, url: page.url() });
        continue;
      }
      const before = await captureApplicationState(page);
      attemptedSignatures.add(action.signature);
      const result = await clickSafeAction(page, action);
      if (!result.clicked) continue;

      const nextDepth = current.depth + 1;
      const edgeLabel = `click: ${action.label}`;
      if (result.popup) {
        const popupUrl = cleanUrl(result.popup.url());
        if (popupUrl && sameOrigin(report.targetUrl, popupUrl)) {
          routeActions.push({ source: current.nodeId, url: popupUrl, depth: nextDepth, label: action.label, edgeLabel, selector: action.path, type: "popup", popup: true });
          routeTargets.add(popupUrl);
        }
        await result.popup.close().catch(() => {});
        continue;
      }

      let clickedUrl = cleanUrl(page.url());
      if (clickedUrl && !sameOrigin(report.targetUrl, clickedUrl)) {
        if (config.login?.email && config.login?.password && await isLoginSurface(page)) {
          emit({ type: "session", message: `A login gate appeared after “${action.label}”; applying the supplied credentials.`, url: clickedUrl });
          await ensureAuthenticated(session, config, emit, { useCurrentPage: true });
          clickedUrl = cleanUrl(page.url());
        }
        if (clickedUrl && !sameOrigin(report.targetUrl, clickedUrl)) {
          emit({ type: "page-error", message: `Skipped “${action.label}” because it left the application for an external origin.`, url: clickedUrl });
          await restore(current.path);
          continue;
        }
      } else if (config.login?.email && config.login?.password && await isLoginSurface(page)) {
        emit({ type: "session", message: `A login gate appeared after “${action.label}”; applying the supplied credentials.`, url: clickedUrl || page.url() });
        await ensureAuthenticated(session, config, emit, { useCurrentPage: true });
      }

      await resolveContextChooserIfPresent(page, config, emit, { appearanceTimeout: config.login?.postLoginValue ? 2_500 : 0 });

      const navigatedUrl = cleanUrl(page.url());
      if (navigatedUrl && navigatedUrl !== cleanUrl(before.url)) {
        if (sameOrigin(report.targetUrl, navigatedUrl)) {
          routeActions.push({
            source: current.nodeId,
            url: navigatedUrl,
            depth: nextDepth,
            label: action.label,
            edgeLabel,
            selector: action.path,
            type: "click",
            _replay: { baseUrl: replayRoot.baseUrl, rootFingerprint: replayRoot.rootFingerprint, path: [...replayRoot.path, ...current.path, action] }
          });
          routeTargets.add(navigatedUrl);
        }
        continue;
      }

      const after = await captureApplicationState(page);
      if (after.fingerprint === before.fingerprint) continue;
      let stateId = knownStates.get(after.fingerprint);
      if (!stateId) {
        stateId = `${url}::state:${after.fingerprint}`;
        knownStates.set(after.fingerprint, stateId);
        const label = after.dialogs[0] || after.selectedTabs.at(-1) || after.headings[0] || action.label;
        const stateType = after.dialogs.length ? "dialog" : "interaction";
        const previousIssueCount = pageRecord.issueIds.length;
        emit({ type: "state", message: `Scanning ${stateType} state after “${action.label}”.`, url });
        await scanCurrentState({ page, url, state: `${stateType}:${label.slice(0, 60)}`, outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex });
        pageRecord.observedStates.push({
          id: stateId,
          stateId: after.fingerprint,
          label: label.slice(0, 100),
          url,
          depth: nextDepth,
          issueCount: pageRecord.issueIds.length - previousIssueCount,
          status: "scanned",
          state: stateType
        });
        if (nextDepth < maxDepth) work.push({ nodeId: stateId, path: [...current.path, action], depth: nextDepth });
      }
      pageRecord.stateEdges.push({ source: current.nodeId, target: stateId, type: "click", label: edgeLabel, selector: action.path });
    }

    const progressAfter = pageRecord.observedStates.length + routeTargets.size;
    if (progressAfter === progressBefore && config.aiEnabled && (config.openAiApiKey || config.aiGroundingChooser) && !aiAttemptedStates.has(current.nodeId)) {
      aiAttemptedStates.add(current.nodeId);
      const stallMs = Math.max(0, Number(config.aiCrawlerStallMs || 50_000));
      const remaining = Math.max(0, stallMs - (Date.now() - stalledSince));
      emit({ type: "ai-grounding-wait", message: `No new crawl state was found. Waiting ${Math.ceil(remaining / 1_000)}s before numbered-element AI fallback.`, url: page.url() });
      if (remaining) await page.waitForTimeout(remaining);
      if (!(await restore(current.path))) continue;
      await waitForPageReady(page, { timeout: 20_000, settleMs: 900 });
      const before = await captureApplicationState(page);
      const result = await attemptAiGroundedAction(page, { config, onEvent: emit, chooseNumber: config.aiGroundingChooser });
      if (!result.clicked) continue;

      const nextDepth = current.depth + 1;
      const edgeLabel = `AI click #${result.action.number}: ${result.action.label}`;
      if (result.popup) {
        const popupUrl = cleanUrl(result.popup.url());
        if (popupUrl && sameOrigin(report.targetUrl, popupUrl)) {
          routeActions.push({ source: current.nodeId, url: popupUrl, depth: nextDepth, label: result.action.label, edgeLabel, selector: result.action.path, type: "ai-popup", popup: true });
          routeTargets.add(popupUrl);
        }
        await result.popup.close().catch(() => {});
        continue;
      }

      let clickedUrl = cleanUrl(page.url());
      if (clickedUrl && !sameOrigin(report.targetUrl, clickedUrl)) {
        emit({ type: "page-error", message: `Rejected AI choice #${result.action.number} because it left the application origin.`, url: clickedUrl });
        await restore(current.path);
        continue;
      }
      if (config.login?.email && config.login?.password && await isLoginSurface(page)) {
        emit({ type: "session", message: `A login gate appeared after AI choice #${result.action.number}; applying the supplied credentials.`, url: clickedUrl || page.url() });
        await ensureAuthenticated(session, config, emit, { useCurrentPage: true });
        clickedUrl = cleanUrl(page.url());
      }
      await resolveContextChooserIfPresent(page, config, emit, { appearanceTimeout: config.login?.postLoginValue ? 2_500 : 0 });
      clickedUrl = cleanUrl(page.url());
      if (clickedUrl && clickedUrl !== cleanUrl(before.url)) {
        if (sameOrigin(report.targetUrl, clickedUrl)) {
          routeActions.push({
            source: current.nodeId,
            url: clickedUrl,
            depth: nextDepth,
            label: result.action.label,
            edgeLabel,
            selector: result.action.path,
            type: "ai-click",
            _replay: { baseUrl: replayRoot.baseUrl, rootFingerprint: replayRoot.rootFingerprint, path: [...replayRoot.path, ...current.path, result.action] }
          });
          routeTargets.add(clickedUrl);
        }
        continue;
      }

      const after = await captureApplicationState(page);
      if (after.fingerprint === before.fingerprint) continue;
      let stateId = knownStates.get(after.fingerprint);
      if (!stateId) {
        stateId = `${url}::state:${after.fingerprint}`;
        knownStates.set(after.fingerprint, stateId);
        const label = after.dialogs[0] || after.selectedTabs.at(-1) || after.headings[0] || result.action.label;
        const stateType = after.dialogs.length ? "dialog" : "ai-interaction";
        const previousIssueCount = pageRecord.issueIds.length;
        emit({ type: "state", message: `Scanning state revealed by AI choice #${result.action.number}.`, url });
        await scanCurrentState({ page, url, state: `${stateType}:${label.slice(0, 60)}`, outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex });
        pageRecord.observedStates.push({ id: stateId, stateId: after.fingerprint, label: label.slice(0, 100), url, depth: nextDepth, issueCount: pageRecord.issueIds.length - previousIssueCount, status: "scanned", state: stateType });
      }
      pageRecord.stateEdges.push({ source: current.nodeId, target: stateId, type: "ai-click", label: edgeLabel, selector: result.action.path });
    }
  }

  pageRecord.interactionCoverage = {
    candidatesFound: candidateSignatures.size,
    actionsAttempted: attemptedSignatures.size,
    statesDiscovered: pageRecord.observedStates.length,
    routesDiscovered: routeTargets.size,
    restoreFailures
  };
  emit({
    type: "actions-summary",
    message: `Interaction coverage: attempted ${attemptedSignatures.size} of ${candidateSignatures.size} discovered candidates; recorded ${pageRecord.observedStates.length} states and ${routeTargets.size} routes.`,
    url: page.url()
  });

  return routeActions;
}

function addEdge(report, keys, source, target, type, label = type, selector = null) {
  const key = `${source}|${target}|${type}|${label}`;
  if (source === target || keys.has(key)) return;
  keys.add(key);
  report.graph.edges.push({ source, target, type, label, selector });
}

async function openScanTarget({ page, url, replay, reuseCurrentPage, emit }) {
  if (reuseCurrentPage) {
    await waitForPageReady(page, { timeout: 60_000, shellWaitMs: 300_000, settleMs: 1_000 });
    return null;
  }

  if (replay?.baseUrl && replay?.path?.length) {
    emit({ type: "route-replay", message: "Opening the protected application route through its recorded in-app action path.", url });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const restored = await restoreActionPath(page, replay.baseUrl, replay.path, { expectedRootFingerprint: replay.rootFingerprint });
      if (!restored) continue;
      await waitForPageReady(page, { timeout: 50_000, shellWaitMs: 50_000, settleMs: 900 });
      const accessFailure = await detectPageAccessFailure(page);
      if (!accessFailure && samePageUrl(page.url(), url)) return null;
    }
    emit({ type: "crawl-warning", message: "The recorded in-app action path could not reopen the route; trying its URL in the same authenticated browser session.", url });
  }

  return navigateAndWait(page, url, { timeout: 60_000, shellWaitMs: 300_000, settleMs: 1_000 });
}

function shortStateId(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 10);
}

function countRecordedStates(report) {
  return report.pages.reduce((total, page) => total + 1 + (page.observedStates?.length || 0), 0);
}

function findingKey(finding) {
  return `${finding.pageUrl}|${finding.frameUrl}|${finding.ruleId}|${JSON.stringify(finding.target)}`;
}

function summarize(report) {
  const byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const issue of report.issues) byImpact[issue.impact] = (byImpact[issue.impact] || 0) + 1;
  return {
    pagesScanned: report.pages.length,
    statesObserved: countRecordedStates(report),
    confirmedIssues: report.issues.length,
    needsReview: report.incomplete.length,
    byImpact,
    evidenceScreenshots: new Set([...report.issues, ...report.incomplete].map((finding) => finding.evidence || finding.contextEvidence).filter(Boolean)).size,
    durationMs: Date.parse(report.completedAt) - Date.parse(report.startedAt),
    aiChecksUsed: report.issues.filter((issue) => issue.source?.startsWith("gpt-")).length
  };
}

function validateTarget(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Target URL must use http or https.");
  if (!/^#(?:!\/|\/)/.test(url.hash)) url.hash = "";
  return url.href.replace(/\/$/, "") || url.href;
}

function cleanUrl(value) {
  return sanitizeUrl(value);
}

function stableRestoreUrl(actualUrl, requestedUrl) {
  try {
    const actual = new URL(actualUrl);
    const requested = new URL(requestedUrl);
    const callbackPath = /(?:^|\/)(?:callback|signin-callback|oauth2?\/callback)(?:\/|$)/i.test(actual.pathname);
    const authorizationResponse = actual.searchParams.has("code") && actual.searchParams.has("state");
    if (actual.origin === requested.origin && (callbackPath || authorizationResponse)) return requested.href;
    return actual.href;
  } catch {
    return requestedUrl;
  }
}

function sameOrigin(a, b) {
  return new URL(a).origin === new URL(b).origin;
}

function samePageUrl(a, b) {
  return cleanUrl(a) === cleanUrl(b);
}

function actionExclusionsForPage(config, pageUrl) {
  if (!config.excludeActionLabels?.length) return [];
  if (!config.excludeActionOrigin) return config.excludeActionLabels;
  try { return new URL(pageUrl).origin === config.excludeActionOrigin ? config.excludeActionLabels : []; }
  catch { return []; }
}

function isExcluded(url, fragments) {
  const { pathname } = new URL(url);
  return fragments.some((fragment) => pathname.toLowerCase().includes(fragment.toLowerCase()));
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";
}
