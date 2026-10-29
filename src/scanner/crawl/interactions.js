import path from "node:path";
import { ensureAuthenticated, isAuthenticationRoute, isLoginSurface } from "../../browser/session.js";
import { resolveBlockingObstruction } from "../../browser/blockers.js";
import { resolveContextChooserIfPresent } from "../../browser/post-login.js";
import { captureApplicationState, clickSafeAction, comparableUrl, inventorySafeActions, restoreActionPath } from "../actions.js";
import { waitForPageReady } from "../../browser/readiness.js";
import { sanitizeUrl } from "../../url-security.js";
import { attemptAiGroundedAction } from "../ai-grounding.js";
import { actionExclusionsFor, isExcludedActionUrl } from "../../browser/action-exclusions.js";
import { createNvdaStateTarget } from "../../assistive-technology/state-targets.js";
import { countRecordedStates } from "./reporting.js";
import { testLiveNvdaState } from "./nvda-bridge.js";
import { scanCurrentState } from "./checks.js";
import { globalStateKey, shortStateId } from "./identity.js";
import { cleanUrl, sameOrigin, isExcluded } from "./navigation.js";

export async function exploreClickableStates({ page, session, config, url, restoreUrl, depth, maxDepth, maxStates, remainingPageSlots, reservedRoutes, knownPageUrls, outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex, evidenceRegistry, emit, entryReplay, nvdaStateTargets, liveNvda, globalStates = new Map(), scanOpenedTab }) {
  if (maxStates <= 0 || depth >= maxDepth) return [];
  await resolveContextChooserIfPresent(page, config, emit);
  const initialBlocker = await resolveBlockingObstruction(page, { onEvent: emit });
  recordBlockerResult({ result: initialBlocker, pageRecord, report, nodeId: url });
  const initial = await captureApplicationState(page);
  let globalStatesReused = 0;
  const blockerRetries = new Map();
  const loginWarnings = new Set();
  const replayRoot = entryReplay || { baseUrl: restoreUrl, rootFingerprint: initial.fingerprint, path: [] };
  const knownStates = new Map([[initial.fingerprint, url]]);
  const routeActions = [];
  const routeTargets = new Set();
  // Leave room for at least the base scan of pending pages. Route discovery does
  // not itself consume an observed-state slot.
  const availablePages = () => Math.max(0, Math.min(remainingPageSlots, config.maxPages - report.pages.length));
  const availableStates = () => Math.max(0, (Number(config.maxStates) || 100) - countRecordedStates(report));
  const stateCapacity = () => Math.max(0, Math.min(
    maxStates - Math.min(availablePages(), new Set([...reservedRoutes, ...routeTargets].filter((target) => !knownPageUrls.has(target))).size),
    pageRecord.observedStates.length + availableStates()
  ));
  const pageLimitBlocks = (target) => availablePages() <= 0 && target && sameOrigin(report.targetUrl, target) && !knownPageUrls.has(target);
  const recordSkippedRoute = (target, label) => {
    if (!target || isExcluded(target, config.excludePaths) || pageRecord.skippedRoutes.some((entry) => entry.url === target)) return;
    pageRecord.skippedRoutes.push({ url: target, label, reason: "page_limit_reached" });
    emit({ type: "action-skip", message: `Skipped the route revealed by “${label}” because the configured ${config.maxPages}-page limit was reached; same-page interactions continue.`, url: target });
  };
  const work = [{ nodeId: url, path: [], depth, fingerprint: initial.fingerprint, urlKey: comparableUrl(initial.url) }];
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
  // Skip the restore (and the page reload it may cause) when the page is still
  // in the node's state, e.g. after a click that changed nothing.
  const ensureAt = async (node) => {
    if (node.fingerprint && comparableUrl(page.url()) === node.urlKey) {
      const now = await captureApplicationState(page).catch(() => null);
      if (now?.fingerprint === node.fingerprint) return true;
    }
    return restore(node.path);
  };
  // Credentials go only to a plain sign-in form on an authentication route.
  const reauthenticateIfLoginGate = async (label) => {
    if (!config.login?.email || !config.login?.password || !(await isLoginSurface(page))) return false;
    if (!isAuthenticationRoute(page.url(), config)) {
      const key = comparableUrl(page.url());
      if (!loginWarnings.has(key)) {
        loginWarnings.add(key);
        const message = `A sign-in form appeared on an application page after “${label}”. Credentials were not entered because the page is not an authentication route.`;
        emit({ type: "crawl-warning", message, url: page.url() });
        report.limitations.push(`${sanitizeUrl(page.url()) || "Application page"}: ${message}`);
      }
      return false;
    }
    emit({ type: "session", message: `A login gate appeared after “${label}”; applying the supplied credentials.`, url: page.url() });
    await ensureAuthenticated(session, config, emit, { useCurrentPage: true });
    return true;
  };

  while (work.length && availableStates() > 0) {
    if (page.isClosed() || session.isStopped?.()) break;
    const current = work.shift();
    const currentStateIsAlreadyOpen = useCurrentRootState && current.path.length === 0;
    if (!currentStateIsAlreadyOpen && !(await ensureAt(current))) continue;
    await resolveContextChooserIfPresent(page, config, emit);
    const actions = await inventorySafeActions(page, { excludeLabels: actionExclusionsFor(config, page.url()) });
    actions.forEach((action) => candidateSignatures.add(action.signature));
    const progressBefore = pageRecord.observedStates.length + routeTargets.size;
    const stalledSince = Date.now();
    useCurrentRootState = false;
    const remainingCapacity = Math.max(0, stateCapacity() - pageRecord.observedStates.length);
    emit({ type: "actions", message: `Found ${actions.length} safe clickable candidates in state ${shortStateId(current.nodeId)}; ${remainingCapacity} additional interaction states fit in the state budget.`, url });

    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      if (page.isClosed() || session.isStopped?.()) break;
      const action = actions[actionIndex];
      if (availableStates() <= 0) break;
      // An opened tab consumes its own page/state reservation, not an extra
      // interaction state on the parent. It can use the reserved route slot.
      if (pageRecord.observedStates.length >= stateCapacity() && !action.opensTab) continue;
      const linkedUrl = cleanUrl(action.href);
      if (pageLimitBlocks(linkedUrl)) {
        recordSkippedRoute(linkedUrl, action.label);
        continue;
      }
      if (linkedUrl && sameOrigin(report.targetUrl, linkedUrl) && !knownPageUrls.has(linkedUrl)
          && !action.opensTab && routeTargets.size >= availablePages()) {
        // Keep additional links available to the page queue without spending
        // every interaction attempt navigating routes that cannot fit this run.
        if (!isExcluded(linkedUrl, config.excludePaths) && !routeActions.some((entry) => entry.url === linkedUrl)) {
          routeActions.push({ source: current.nodeId, url: linkedUrl, depth: current.depth + 1, label: action.label, selector: action.path, type: "navigate" });
        }
        continue;
      }
      const canUseOpenState = currentStateIsAlreadyOpen && actionIndex === 0;
      if (!canUseOpenState && !(await ensureAt(current))) {
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
        if (pageLimitBlocks(popupUrl)) recordSkippedRoute(popupUrl, action.label);
        if (popupUrl && sameOrigin(report.targetUrl, popupUrl)) {
          routeActions.push({ source: current.nodeId, url: popupUrl, depth: nextDepth, label: action.label, edgeLabel, selector: action.path, type: "popup", popup: true });
          routeTargets.add(popupUrl);
        }
        if (scanOpenedTab) {
          const tabResult = await scanOpenedTab({ opener: page, popup: result.popup, source: current.nodeId, depth: nextDepth, label: action.label, selector: action.path });
          if (popupUrl && ["scanned", "failed"].includes(tabResult.status)) knownPageUrls.add(popupUrl);
        } else await result.popup.close().catch(() => {});
        continue;
      }

      let clickedUrl = cleanUrl(page.url());
      let reauthenticated = false;
      if (clickedUrl && !sameOrigin(report.targetUrl, clickedUrl)) {
        reauthenticated = await reauthenticateIfLoginGate(action.label);
        if (reauthenticated) clickedUrl = cleanUrl(page.url());
        if (clickedUrl && !sameOrigin(report.targetUrl, clickedUrl)) {
          emit({ type: "page-error", message: `Skipped “${action.label}” because it left the application for an external origin.`, url: clickedUrl });
          await restore(current.path);
          continue;
        }
      } else {
        reauthenticated = await reauthenticateIfLoginGate(action.label);
      }

      await resolveContextChooserIfPresent(page, config, emit, { appearanceTimeout: config.login?.postLoginValue ? 2_500 : 0, afterAuthentication: reauthenticated });

      const navigatedUrl = cleanUrl(page.url());
      if (navigatedUrl && navigatedUrl !== cleanUrl(before.url)) {
        if (isExcludedActionUrl(page.url(), actionExclusionsFor(config, page.url()))) {
          emit({ type: "action-skip", message: `“${action.label}” opened an address on the Do not click list; that page was not scanned or used.`, url: navigatedUrl });
          await restore(current.path);
          continue;
        }
        if (pageLimitBlocks(navigatedUrl)) {
          recordSkippedRoute(navigatedUrl, action.label);
          await restore(current.path);
          continue;
        }
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
      const globalKey = action.region === "global" && current.path.length === 0 ? globalStateKey(action, before, after) : null;
      const reused = !stateId && globalKey ? globalStates.get(globalKey) : null;
      if (reused && reused.pageUrl !== url) {
        // The same header/navigation menu was already scanned on another page.
        stateId = reused.stateId;
        knownStates.set(after.fingerprint, stateId);
        globalStatesReused += 1;
        emit({ type: "state-reused", message: `Linked the shared navigation state opened by “${action.label}” to its earlier scan instead of scanning it again.`, url });
      } else if (!stateId) {
        stateId = `${url}::state:${after.fingerprint}`;
        knownStates.set(after.fingerprint, stateId);
        if (globalKey && !globalStates.has(globalKey)) globalStates.set(globalKey, { stateId, pageUrl: url });
        const label = after.dialogs[0] || after.selectedTabs.at(-1) || after.headings[0] || action.label;
        const stateType = after.dialogs.length ? "dialog" : "interaction";
        const nvdaTarget = {
          id: stateId, stateId: after.fingerprint, state: `${stateType}:${label.slice(0, 60)}`,
          url: cleanUrl(after.url), pageUrl: url, title: label.slice(0, 100), snapshot: after,
          replay: { baseUrl: replayRoot.baseUrl, path: [...replayRoot.path, ...current.path, action] }
        };
        if (config.nvdaRunner || config.nvdaCollectTargets) nvdaStateTargets.push(createNvdaStateTarget(nvdaTarget));
        const previousIssueCount = pageRecord.issueIds.length;
        emit({ type: "state", message: `Scanning ${stateType} state after “${action.label}”.`, url });
        await scanCurrentState({ page, url, state: `${stateType}:${label.slice(0, 60)}`, outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex, evidenceRegistry, config });
        pageRecord.observedStates.push({
          id: stateId,
          stateId: after.fingerprint,
          label: label.slice(0, 100),
          url,
          depth: nextDepth,
          issueCount: pageRecord.issueIds.length - previousIssueCount,
          status: "scanned",
          state: stateType,
          findingState: `${stateType}:${label.slice(0, 60)}`
        });
        const nvdaResult = await testLiveNvdaState({ liveNvda, page, target: nvdaTarget, report, emit });
        if (nvdaResult?.stateChanged) pageRecord.observedStates.at(-1).nvdaStateChanged = true;
        // A deeper branch is restored through its safe action path on the next
        // iteration; it must not be explored against a state changed by Tab.
        if (nextDepth < maxDepth) work.push({ nodeId: stateId, path: [...current.path, action], depth: nextDepth, fingerprint: after.fingerprint, urlKey: comparableUrl(after.url) });
      }
      pageRecord.stateEdges.push({ source: current.nodeId, target: stateId, type: "click", label: edgeLabel, selector: action.path });
    }

    const progressAfter = pageRecord.observedStates.length + routeTargets.size;
    let blockerRecovery = null;
    if (progressAfter === progressBefore) {
      const parentPath = current.path.length ? current.path.slice(0, -1) : [];
      blockerRecovery = await resolveBlockingObstruction(page, {
        onEvent: emit,
        restore: () => restore(parentPath)
      });
      recordBlockerResult({ result: blockerRecovery, pageRecord, report, nodeId: current.nodeId });
      // A popup that returns after every restore must not re-queue the same
      // state forever; two retries are enough to get past a one-time notice.
      const retries = blockerRetries.get(current.nodeId) || 0;
      if (blockerRecovery.detected && blockerRecovery.handled && current.path.length === 0 && retries < 2) {
        blockerRetries.set(current.nodeId, retries + 1);
        work.unshift(current);
        continue;
      }
      if (blockerRecovery.detected && blockerRecovery.handled && retries >= 2) {
        const message = "A blocking dialog kept reappearing after it was dismissed; the crawler stopped retrying this state.";
        emit({ type: "crawl-warning", message, url: page.url() });
        if (!report.limitations.includes(`${pageRecord.url}: ${message}`)) report.limitations.push(`${pageRecord.url}: ${message}`);
      }
    }
    if (pageRecord.observedStates.length < stateCapacity() && progressAfter === progressBefore && !blockerRecovery?.detected && config.aiEnabled && (config.openAiApiKey || config.aiGroundingChooser) && !aiAttemptedStates.has(current.nodeId)) {
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
        if (pageLimitBlocks(popupUrl)) recordSkippedRoute(popupUrl, result.action.label);
        if (popupUrl && sameOrigin(report.targetUrl, popupUrl)) {
          routeActions.push({ source: current.nodeId, url: popupUrl, depth: nextDepth, label: result.action.label, edgeLabel, selector: result.action.path, type: "ai-popup", popup: true });
          routeTargets.add(popupUrl);
        }
        if (scanOpenedTab) {
          const tabResult = await scanOpenedTab({ opener: page, popup: result.popup, source: current.nodeId, depth: nextDepth, label: result.action.label, selector: result.action.path, type: "ai-popup" });
          if (popupUrl && ["scanned", "failed"].includes(tabResult.status)) knownPageUrls.add(popupUrl);
        } else await result.popup.close().catch(() => {});
        continue;
      }

      let clickedUrl = cleanUrl(page.url());
      if (clickedUrl && !sameOrigin(report.targetUrl, clickedUrl)) {
        emit({ type: "page-error", message: `Rejected AI choice #${result.action.number} because it left the application origin.`, url: clickedUrl });
        await restore(current.path);
        continue;
      }
      const reauthenticated = await reauthenticateIfLoginGate(`AI choice #${result.action.number}`);
      if (reauthenticated) clickedUrl = cleanUrl(page.url());
      await resolveContextChooserIfPresent(page, config, emit, { appearanceTimeout: config.login?.postLoginValue ? 2_500 : 0, afterAuthentication: reauthenticated });
      clickedUrl = cleanUrl(page.url());
      if (clickedUrl && clickedUrl !== cleanUrl(before.url)) {
        if (isExcludedActionUrl(page.url(), actionExclusionsFor(config, page.url()))) {
          emit({ type: "action-skip", message: `AI choice #${result.action.number} opened an address on the Do not click list; that page was not scanned or used.`, url: clickedUrl });
          await restore(current.path);
          continue;
        }
        if (pageLimitBlocks(clickedUrl)) {
          recordSkippedRoute(clickedUrl, result.action.label);
          await restore(current.path);
          continue;
        }
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
        const nvdaTarget = {
          id: stateId, stateId: after.fingerprint, state: `${stateType}:${label.slice(0, 60)}`,
          url: cleanUrl(after.url), pageUrl: url, title: label.slice(0, 100), snapshot: after,
          replay: { baseUrl: replayRoot.baseUrl, path: [...replayRoot.path, ...current.path, result.action] }
        };
        if (config.nvdaRunner || config.nvdaCollectTargets) nvdaStateTargets.push(createNvdaStateTarget(nvdaTarget));
        const previousIssueCount = pageRecord.issueIds.length;
        emit({ type: "state", message: `Scanning state revealed by AI choice #${result.action.number}.`, url });
        await scanCurrentState({ page, url, state: `${stateType}:${label.slice(0, 60)}`, outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex, evidenceRegistry, config });
        pageRecord.observedStates.push({ id: stateId, stateId: after.fingerprint, label: label.slice(0, 100), url, depth: nextDepth, issueCount: pageRecord.issueIds.length - previousIssueCount, status: "scanned", state: stateType, findingState: `${stateType}:${label.slice(0, 60)}` });
        const nvdaResult = await testLiveNvdaState({ liveNvda, page, target: nvdaTarget, report, emit });
        if (nvdaResult?.stateChanged) pageRecord.observedStates.at(-1).nvdaStateChanged = true;
      }
      pageRecord.stateEdges.push({ source: current.nodeId, target: stateId, type: "ai-click", label: edgeLabel, selector: result.action.path });
    }
  }

  pageRecord.interactionCoverage = {
    candidatesFound: candidateSignatures.size,
    actionsAttempted: attemptedSignatures.size,
    statesDiscovered: pageRecord.observedStates.length,
    routesDiscovered: routeTargets.size,
    routesSkippedByPageLimit: pageRecord.skippedRoutes.length,
    stateBudgetReached: pageRecord.observedStates.length >= stateCapacity(),
    statesReservedForPages: Math.min(remainingPageSlots, new Set([...reservedRoutes, ...routeTargets]).size),
    restoreFailures,
    globalStatesReused,
    blockersDetected: pageRecord.blockerRecovery.detected,
    blockersResolved: pageRecord.blockerRecovery.resolved,
    blockersRequiringUser: pageRecord.blockerRecovery.userActionRequired
  };
  emit({
    type: "actions-summary",
    message: `Interaction coverage: attempted ${attemptedSignatures.size} of ${candidateSignatures.size} discovered candidates; recorded ${pageRecord.observedStates.length} states and ${routeTargets.size} routes; resolved ${pageRecord.blockerRecovery.resolved} of ${pageRecord.blockerRecovery.detected} detected blockers.`,
    url: page.url()
  });

  return routeActions;
}

export function recordBlockerResult({ result, pageRecord, report, nodeId }) {
  if (!result?.detected) return;
  const alreadyRecorded = pageRecord.blockerRecovery.records.some((record) =>
    record.fingerprint === result.blocker?.fingerprint && record.method === (result.method || null) && record.reason === (result.reason || null));
  if (alreadyRecorded) return;
  const record = {
    fingerprint: result.blocker?.fingerprint || null,
    title: result.blocker?.title || "Blocking dialog",
    handled: Boolean(result.handled),
    method: result.method || null,
    reason: result.reason || null,
    inputCount: result.blocker?.inputCount || 0
  };
  pageRecord.blockerRecovery.records.push(record);
  pageRecord.blockerRecovery.detected += 1;
  if (result.handled) {
    pageRecord.blockerRecovery.resolved += 1;
    return;
  }
  pageRecord.blockerRecovery.userActionRequired += 1;
  const reason = result.reason || "modal_could_not_be_closed";
  const state = pageRecord.observedStates.find((candidate) => candidate.id === nodeId);
  if (state) {
    state.status = "blocked";
    state.terminationReason = reason;
  } else if (nodeId === pageRecord.url) {
    pageRecord.crawlStatus = "blocked";
    pageRecord.terminationReason = reason;
  }
  const limitation = `${pageRecord.url}: crawl branch blocked by ${reason.replaceAll("_", " ")}; no existing dialog input was changed.`;
  if (!report.limitations.includes(limitation)) report.limitations.push(limitation);
}
