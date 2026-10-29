// Live session lifecycle: startup, ownership, pause/resume, tab transfer, shutdown.
import { randomBytes } from "node:crypto";
import { startNvdaCaptureSession } from "./nvda/capture-session.js";
import { focusAndMaximizeBrowser, prepareNativeDocumentFocus, focusNativeDocumentAnchor,
  inspectNativeDocumentFocus, sendNativeTab, warmNvdaKeyboardHelper, releaseWarmedNvdaHelper } from "./nvda/native-keyboard.js";
import { establishPageKeyboardFocus, describeFocusedElement } from "./nvda/browser-focus.js";
import { waitForActionSpeech } from "./nvda/speech.js";
import { summarizeTiming, inspectLiveState, liveStateIdentity } from "./nvda/live-state-model.js";
import { createNvdaEvidenceWriter } from "./nvda/live-evidence.js";
import { createLiveStateRunner } from "./nvda/live-state-runner.js";
import { restoreNativeScope, cleanupScopeMarker } from "./nvda/scope-recovery.js";
import { createTabScopeWatch } from "./nvda/tab-scope-watch.js";

export { summarizeTiming, inspectLiveState, liveStateIdentity, buildNvdaLivePlan } from "./nvda/live-state-model.js";

const LIMITATIONS = [
  "NVDA tests each available live crawl state while crawler actions are paused. Results cover the commands and states recorded here.",
  "Say All attempts to reach the end of the available browse content and waits for audible completion. A safety timeout or unconfirmed end is partial, not a reading pass. Unvisited, hidden, virtualized and inaccessible content is not covered. Heading and table commands remain bounded samples.",
  "Form completion and end-to-end journeys require explicit application test data and approved workflow scripts; this runner does not fill or submit forms.",
  "Required-field checks cover only reached focus stops. Associated stars without an established meaning and unconfirmed or non-English announcements require review; no required wording is injected into the website or speech.",
  "Captured speech is evidence for review, not a WCAG conformance verdict. Experienced screen-reader users must evaluate usability."
];

export async function createLiveNvdaSession({ config, outputDir, emit = () => {}, dependencies = {} }) {
  const startedAt = new Date().toISOString();
  const warnings = [];
  const prepared = new WeakMap();
  const registeredPages = new Map();
  const focusTrackings = new Map();
  const guardedPages = new Set();
  const nvda = config.nvda || {};
  const startupTiming = {};
  let capture;
  let failure;
  let closed = false;
  let stoppedReason = null;
  let startup;
  let closePromise;
  let boundPage;
  let rootPage;
  let switching = null;
  let applicationOrigin;
  let scopeListener;
  let browser;
  let focusTracking;
  let stopKind = null;
  // Pause/resume (add-on capability "scope-pause"): focus leaving the test tab
  // after the startup handoff pauses the reader instead of ending the run.
  let handoffComplete = false;
  let paused = null;
  let pauseTimer;
  let pauseListener;
  let resuming = null;
  let resumeSequence = 0;
  let countedAttempts = 0;
  let recoveries = 0;
  const pauses = [];
  const pauseWaiters = new Set();
  const finite = (value, fallback) => value == null || value === "" || !Number.isFinite(Number(value)) ? fallback : Math.trunc(Number(value));
  const maxRecoveries = Math.max(0, Math.min(10, finite(nvda.maxRecoveries, 3)));
  const maxPauseMs = Math.max(1000, Math.min(600_000, finite(nvda.maxPauseMs, 120_000)));
  const startupAbort = new AbortController();
  const onPageClosed = () => { void stop("The testing tab was closed; NVDA stopped.", "tab-closed"); };
  const onPageCrashed = () => { void stop("The testing tab crashed; NVDA stopped.", "tab-crashed"); };
  const onBrowserClosed = () => { void stop("The testing browser disconnected; NVDA stopped.", "browser-disconnected"); };
  const runtime = {
    warm: dependencies.start ? () => {} : () => warmNvdaKeyboardHelper(nvda),
    start: startNvdaCaptureSession, inspect: inspectLiveState, focusWindow: focusAndMaximizeBrowser,
    prepareFocus: prepareNativeDocumentFocus, anchor: establishPageKeyboardFocus, nativeAnchor: focusNativeDocumentAnchor, nativeFocus: inspectNativeDocumentFocus,
    trackFocus: async (page) => {
      // Playwright enables focus emulation by default, causing even background
      // tabs to report document.hasFocus() === true. Native testing must use
      // the real tab's visibility and focus for its lifetime guard.
      const session = await page.context().newCDPSession(page);
      try { await session.send("Emulation.setFocusEmulationEnabled", { enabled: false }); }
      catch (error) { await session.detach().catch(() => {}); throw error; }
      return session;
    },
    focusPreparation: (page) => page.locator("#rambo-nvda-prepare-focus").click(),
    sendTab: sendNativeTab, speechWait: waitForActionSpeech, describe: describeFocusedElement,
    tabActive: async (page) => {
      // Chrome reapplies the driver's focus override when a navigation swaps
      // renderer processes. Clear it before each real tab-scope observation.
      await focusTracking?.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      return page.evaluate(() => document.visibilityState === "visible" && document.hasFocus());
    },
    // The add-on's native foreground guard runs every 100 ms; this browser-side
    // check is a second line of defense and does not need to compete with commands.
    scopeIntervalMs: 500,
    scopeTimeoutMs: 1000,
    ...dependencies
  };
  // No reader or keys yet: compile the native helper while Chrome is launching.
  const warmedHelper = runtime.warm();

  function guardPage(page) {
    if (guardedPages.has(page)) return;
    guardedPages.add(page);
    page.on?.("close", onPageClosed);
    page.on?.("crash", onPageCrashed);
  }

  function unguardPage(page) {
    if (!guardedPages.delete(page)) return;
    page.off?.("close", onPageClosed);
    page.off?.("crash", onPageCrashed);
  }

  function httpOrigin(value) {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin : null; }
    catch { return null; }
  }

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    startupAbort.abort();
    scopeWatch.clear();
    clearTimeout(pauseTimer);
    scopeListener?.();
    pauseListener?.();
    for (const page of [...guardedPages]) unguardPage(page);
    browser?.off?.("disconnected", onBrowserClosed);
    closePromise = (async () => {
      const reader = capture || await startup?.catch(() => null);
      await reader?.close();
      const sessions = [...new Set(focusTrackings.values())];
      focusTrackings.clear();
      await Promise.all(sessions.map((session) => session?.detach().catch(() => {})));
      if (!reader) releaseWarmedNvdaHelper(warmedHelper);
      if (reader?.shutdownError) {
        warnings.push(reader.shutdownError);
        emit({ type: "nvda-warning", message: reader.shutdownError });
      }
    })();
    return closePromise;
  }

  async function stop(reason, kind = "other") {
    if (!stoppedReason && !closed) {
      stoppedReason = reason;
      stopKind = kind;
      if (paused) { paused.outcome = "stopped"; paused = null; }
      warnings.push(reason);
      emit({ type: "nvda-warning", message: reason });
    }
    await close();
  }

  // Pausing needs an add-on that advertises it and a completed startup
  // handoff; until then every departure still fails closed.
  const canPause = () => Boolean(handoffComplete && capture?.receiver?.pauseSupported === true && !closed && !stoppedReason && !failure);
  const pausedError = () => Object.assign(new Error(`NVDA is paused: ${paused?.reason || "the testing tab is not in front."}`), { code: "NVDA_PAUSED" });
  // A controller-initiated pause may not be echoed by the add-on, so pending
  // acknowledgement waits are released here instead of running to timeout.
  const unlessPaused = (promise, value) => {
    if (paused) return Promise.resolve(value);
    let release;
    const interrupted = new Promise((resolve) => { release = () => resolve(value); pauseWaiters.add(release); });
    return Promise.race([promise, interrupted]).finally(() => pauseWaiters.delete(release));
  };

  async function enterPause(reason, source, detail = null) {
    if (paused || !canPause()) return;
    scopeWatch.clear();
    const deadlineMs = Date.now() + maxPauseMs;
    paused = { at: new Date().toISOString(), reason, source, detail, resumedAt: null, outcome: "paused", deadlineMs };
    pauses.push(paused);
    for (const release of [...pauseWaiters]) release();
    // The add-on enforces the same deadline; this side releases NVDA even if
    // the caller never comes back to resume it.
    pauseTimer = setTimeout(() => {
      void stop(`NVDA could not be resumed within ${Math.round(maxPauseMs / 1000)} seconds of leaving the testing tab; NVDA stopped. Remaining screen-reader tests were canceled.`, "not-resumed");
    }, maxPauseMs);
    pauseTimer.unref?.();
    capture.control.lifecycle = "paused";
    capture.control.capture = { active: false };
    capture.control.pauseDeadlineMs = deadlineMs;
    emit({ type: "nvda-paused", message: `NVDA paused: ${reason} The agent will bring the testing tab back and resume.` });
    try { await capture.write(); }
    catch (error) { await stop(`NVDA could not be paused safely: ${error.message}`, "pause-failed"); }
  }

  function onReaderPaused(reason, info = {}) {
    // A pause report for a scope this session has already replaced is stale.
    if (closed || paused || (info?.scopeId && capture?.control.scopeId && info.scopeId !== capture.control.scopeId)) return;
    void (canPause() ? enterPause(reason, "addon", info.detail || null) : stop(reason, "reader-stopped"));
  }

  async function requireTestTab(page) {
    if (closed || stoppedReason || capture?.stoppedReason) throw new Error(stoppedReason || capture?.stoppedReason || "The NVDA test session is closed.");
    if (page !== boundPage || switching) throw new Error("This page is not the verified active NVDA testing tab.");
    if (paused) throw pausedError();
    if (page.isClosed?.()) {
      await stop("The testing tab was closed; NVDA stopped. Remaining screen-reader tests were canceled.", "tab-closed");
      throw new Error(stoppedReason || "The NVDA test session is closed.");
    }
    if (await runtime.tabActive(page) === false) {
      if (canPause()) await enterPause("The testing tab lost focus.", "tab-check");
      else await stop("The testing tab lost focus or was closed; NVDA stopped. Remaining screen-reader tests were canceled.", "lost-focus");
      throw paused ? pausedError() : new Error(stoppedReason || "The NVDA test session is closed.");
    }
  }

  async function resume(page, { countsTowardLimit = true } = {}) {
    if (switching) return false;
    if (resuming) return resuming;
    if (closed || stoppedReason || failure || stateRunner.busy) return false;
    if (!paused) return handoffComplete;
    // A natively verified end-of-document Tab is an expected boundary, not
    // unexpected focus loss. Keep all scope/identity checks, but do not spend
    // the run-wide recovery allowance on each short page or dialog.
    resuming = attemptResume(page, countsTowardLimit && !paused.documentBoundaryVerified).finally(() => { resuming = null; });
    return resuming;
  }

  async function attemptResume(page, countsTowardLimit, { controlled = false, newPage = false } = {}) {
    if (page !== boundPage) return false;
    if (page.isClosed?.()) { await stop("The testing tab was closed; NVDA stopped.", "tab-closed"); return false; }
    // Only unexpected departures count; tabs the agent itself opened do not.
    if (countsTowardLimit) {
      if (countedAttempts >= maxRecoveries) {
        await stop(`NVDA could not be resumed: the limit of ${maxRecoveries} recover${maxRecoveries === 1 ? "y" : "ies"} after unexpected focus loss (NVDA_MAX_RECOVERIES) was reached. Last pause: ${paused.reason} Remaining screen-reader tests were canceled.`, "not-resumed");
        return false;
      }
      countedAttempts++;
    }
    const pause = paused;
    const window = prepared.get(page);
    const title = `RAMBO NVDA ${capture.runId} r${++resumeSequence}`;
    const marker = { pinned: false };
    try {
      const focused = await restoreNativeScope({ page, window, title, capture, runtime,
        controlled, newPage, applicationOrigin, isClosed: () => closed, isStopped: () => stoppedReason, stop, httpOrigin, marker });
      if (!focused) return false;
      if (newPage) prepared.set(page, { processId: focused.processId, windowHandle: String(focused.windowHandle) });
      clearTimeout(pauseTimer);
      pause.resumedAt = new Date().toISOString();
      pause.outcome = "resumed";
      paused = null;
      if (countsTowardLimit) recoveries++;
      scopeWatch.start();
      emit({ type: "nvda-resumed", message: "NVDA resumed on the testing tab." });
      return true;
    } catch (error) {
      if (capture?.stoppedReason) await stop(capture.stoppedReason, "reader-stopped");
      if (closed || stoppedReason) return false;
      // Stay paused; the add-on also stays paused after a rejected handoff.
      capture.control.lifecycle = "paused";
      capture.control.capture = { active: false };
      capture.control.pauseDeadlineMs = pause.deadlineMs;
      try { await capture.write(); }
      catch (writeError) { await stop(`NVDA could not be paused safely: ${writeError.message}`, "pause-failed"); return false; }
      emit({ type: "nvda", message: `NVDA is still paused and could not resume yet: ${error.message}` });
      return false;
    } finally {
      await cleanupScopeMarker(page, marker);
    }
  }

  // Only a verified application-created child or a previously registered tab
  // can receive this reader. The original Page is retained and never reloaded.
  async function switchToPage(page, { opener } = {}) {
    if (switching || resuming || stateRunner.busy || closed || stoppedReason || failure || !handoffComplete) return false;
    if (page === boundPage && !paused) return true;
    if (!canPause() || !page || page.isClosed?.() || !rootPage || page.context?.() !== rootPage.context?.()) return false;
    const origin = applicationOrigin || httpOrigin(config.targetUrl) || httpOrigin(rootPage.url());
    if (!origin || httpOrigin(page.url()) !== origin) return false;
    const known = registeredPages.has(page);
    if (!known) {
      if (!opener || opener !== boundPage || httpOrigin(opener.url()) !== origin) return false;
      try { if (await page.opener?.() !== opener) return false; } catch { return false; }
    }
    // Opener resolution is asynchronous; another transition may have started.
    if (switching || resuming || stateRunner.busy || closed || stoppedReason) return false;
    applicationOrigin = origin;
    switching = transferPage(page, known).finally(() => { switching = null; });
    return switching;
  }

  async function transferPage(page, known) {
    const previousPage = boundPage;
    const previousTracking = focusTracking;
    let newTracking = false;
    let succeeded = false;
    try {
      await enterPause("Moving between verified application tabs.", "application-tab");
      if (!paused || closed) return false;
      // Even an already paused reader must acknowledge disarming before scope
      // or focus changes; a lost pause report must not leave capture armed.
      capture.control.lifecycle = "paused";
      capture.control.capture = { active: false };
      await capture.write();
      if (closed || page.isClosed?.() || rootPage.isClosed?.()) return false;
      if (previousPage !== page && !previousPage.isClosed?.()) registeredPages.get(previousPage).returnIdentity = liveStateIdentity(await runtime.inspect(previousPage));
      const returnIdentity = registeredPages.get(page)?.returnIdentity;
      if (returnIdentity && liveStateIdentity(await runtime.inspect(page)) !== returnIdentity) throw new Error("The retained application tab changed state while another tab was tested.");
      if (!focusTrackings.has(page)) {
        const tracking = await runtime.trackFocus(page);
        if (closed) { await tracking?.detach().catch(() => {}); return false; }
        focusTrackings.set(page, tracking);
        newTracking = true;
      }
      guardPage(page);
      boundPage = page;
      focusTracking = focusTrackings.get(page);
      if (httpOrigin(page.url()) !== applicationOrigin) throw new Error("The application tab left the approved origin before handoff.");
      succeeded = await attemptResume(page, false, { controlled: true, newPage: !known });
      if (!succeeded) return false;
      if (!known) registeredPages.set(page, {});
      if (previousPage !== rootPage && previousPage !== page) unguardPage(previousPage);
      emit({ type: "nvda", message: "NVDA is ready on the selected application tab." });
      return true;
    } catch (error) {
      warnings.push(`NVDA application tab handoff: ${error.message}`);
      if (!closed && capture) {
        capture.control.lifecycle = "paused";
        capture.control.capture = { active: false };
        try { await capture.write(); }
        catch (writeError) { await stop(`NVDA tab handoff could not be disarmed safely: ${writeError.message}`, "disarm-failed"); }
      }
      return false;
    } finally {
      if (!succeeded) {
        boundPage = previousPage;
        focusTracking = previousTracking;
        if (page !== rootPage && page !== previousPage) unguardPage(page);
        if (newTracking) {
          const tracking = focusTrackings.get(page);
          focusTrackings.delete(page);
          await tracking?.detach().catch(() => {});
        }
      }
    }
  }

  async function preparePage(page) {
    if (failure || closed) return false;
    if (prepared.has(page)) return true;
    if (boundPage && page !== boundPage) return false;
    if (!/^(?:about:blank)?$/.test(page.url())) return false;
    const title = `RAMBO NVDA prepare ${randomBytes(6).toString("hex")}`;
    const preparingAt = Date.now();
    try {
      emit({ type: "nvda", message: "Preparing the testing tab for NVDA. The application will open automatically." });
      focusTracking = await runtime.trackFocus(page);
      if (closed) { await focusTracking?.detach().catch(() => {}); return false; }
      focusTrackings.set(page, focusTracking);
      await page.setContent(`<html><head><title>${title}</title></head><body><h1>Starting the accessibility test</h1><p>NVDA is connecting to this tab. Your application will open automatically; no click is needed.</p><button id="rambo-nvda-prepare-focus" type="button">Prepare document focus</button></body></html>`);
      if (closed || startupAbort.signal.aborted) return false;
      await page.bringToFront();
      if (closed || startupAbort.signal.aborted) return false;
      const window = await runtime.focusWindow(title);
      if (!window.ok) throw new Error(window.reason);
      if (closed || startupAbort.signal.aborted) return false;
      // Warm up Chrome's native document on our own blank-page button before
      // NVDA initializes. No application or login controls exist here yet.
      await runtime.focusPreparation(page);
      if (page.isClosed?.()) throw new Error("The testing tab closed before NVDA startup.");
      if (await runtime.tabActive(page) === false) throw new Error("The testing tab lost focus before NVDA startup; the reader was not launched.");
      startupTiming.browserFocusMs = Date.now() - preparingAt;
      boundPage = page;
      rootPage = page;
      guardPage(page);
      browser = page.context?.().browser?.();
      browser?.on?.("disconnected", onBrowserClosed);
      // Start only after Chrome document focus is established. This run owns
      // the reader and never borrows a reader already running on the desktop.
      const readerStartingAt = Date.now();
      const browserScope = { processId: window.processId, windowHandle: window.windowHandle };
      startup = runtime.start({ config, outputDir, emit, signal: startupAbort.signal, browserScope, startupHandoff: true });
      capture = await startup;
      if ((nvda.tests || ["reading"]).includes("reading") && capture.receiver.readingCompletionSupported === false) {
        throw new Error("Update the NVDA add-on for read-to-end testing: run npm run install:nvda-addon, exit NVDA and retry.");
      }
      startupTiming.readerReadyMs = Date.now() - readerStartingAt;
      if (closed) { await closePromise; return false; }
      scopeListener = capture.receiver.onScopeStopped?.((reason) => { void stop(reason, "reader-stopped"); });
      pauseListener = capture.receiver.onScopePaused?.(onReaderPaused);
      if (capture.stoppedReason) throw new Error(capture.stoppedReason);
      // NVDA's Windows startup notification can temporarily activate Settings.
      // Startup is quiet; perform exactly one handoff to the same owned Chrome
      // window after core initialization, before navigating to any application.
      if (page.isClosed?.()) throw new Error("The testing tab closed during NVDA startup.");
      const nativeFocusAt = Date.now();
      const handoff = await runtime.focusWindow(title);
      if (!handoff.ok || handoff.processId !== window.processId || String(handoff.windowHandle) !== String(window.windowHandle)) {
        throw new Error(handoff.reason || "The original testing Chrome window could not be verified after NVDA startup.");
      }
      await requireTestTab(page);
      await runtime.focusPreparation(page);
      const readerFocus = await runtime.prepareFocus(title, window.processId);
      if (!readerFocus.ok) throw new Error(readerFocus.reason);
      await requireTestTab(page);
      startupTiming.nativeFocusMs = Date.now() - nativeFocusAt;
      capture.control.browserScope = { ...browserScope, titleMarker: title };
      capture.control.lifecycle = "testing";
      capture.control.scopeId = randomBytes(8).toString("hex");
      await capture.write();
      if (!await capture.receiver.waitForScope(capture.control.scopeId, 2500)) {
        throw new Error(capture.stoppedReason || "NVDA did not confirm the testing Chrome scope after startup.");
      }
      await requireTestTab(page);
      if (closed) { await closePromise; return false; }
      prepared.set(page, window);
      registeredPages.set(page, {});
      handoffComplete = true;
      scopeWatch.start();
      emit({ type: "nvda", message: "NVDA is ready for this testing tab; opening the application now." });
      return true;
    } catch (error) {
      if (!stoppedReason) failure = error.message;
      warnings.push(`NVDA browser preparation: ${error.message}`);
      emit({ type: "nvda-warning", message: `NVDA browser preparation: ${error.message}. The accessibility crawl will continue without NVDA.` });
      await close();
      return false;
    } finally {
      startupTiming.totalMs = Date.now() - preparingAt;
    }
  }

  function finish() {
    const { states, seen, pausedIds, skipped } = stateRunner.results();
    const actions = states.flatMap((state) => state.actions);
    const executed = actions.filter((action) => ["executed", "partial"].includes(action.status));
    const needsReview = actions.filter((action) => action.outcome === "needs-review").length;
    // States reported as paused and never retried must not read as covered.
    const notRetried = pausedIds.size;
    const interrupted = notRetried > 0 || states.some((state) => state.status === "interrupted");
    const reason = failure || stoppedReason || (interrupted ? pauses.at(-1)?.reason || "NVDA testing was interrupted before completing the selected state." : null);
    return {
      product: "NVDA", executionMode: "live-during-crawl", started: Boolean(capture?.receiver.version), actualExecution: executed.length > 0,
      status: failure ? "unavailable" : interrupted ? "interrupted" : executed.length ? "executed" : "blocked",
      outcome: interrupted ? (executed.length ? "partially-tested" : "interrupted") : !executed.length ? "not-executed" : warnings.length || needsReview || skipped || stoppedReason || states.some((state) => state.status !== "executed") ? "needs-review" : "completed",
      reason, stoppedReason, version: capture?.receiver.version || null, browser: config.browserChannel || "Chromium",
      startedAt, completedAt: new Date().toISOString(),
      coverage: { mode: "headed-windows-live-state", statesDiscovered: seen.size, statesSelected: states.length, statesAttempted: states.length,
        statesExecuted: states.filter((state) => state.status === "executed").length, statesInterrupted: states.filter((state) => state.status === "interrupted").length, statesSkippedByLimit: skipped, statesNotTestedWhilePaused: notRetried,
        keyboardCommands: executed.length, announcementsCaptured: actions.reduce((total, action) => total + action.announcements.length, 0), needsReview,
        readingCompleted: actions.filter((action) => action.kind === "reading" && action.readingCompletion === "completed" && action.outcome === "announced").length,
        readingIncomplete: actions.filter((action) => action.kind === "reading" && (action.readingCompletion !== "completed" || action.outcome !== "announced")).length },
      startupTiming: { ...startupTiming }, timing: summarizeTiming(actions),
      speechSettings: capture?.receiver.speechSettings || null,
      pauses: pauses.map(({ at, reason, source, detail, resumedAt, outcome }) => ({ at, reason, source, detail, resumedAt, outcome })),
      recoveries, stopKind: stopKind || (failure ? "unavailable" : null),
      states, warnings: [...warnings, ...(skipped ? [`${skipped} state(s) exceeded the configured NVDA state limit.`] : []),
        ...(notRetried ? [`${notRetried} state(s) remain incomplete because NVDA paused. Available partial evidence is retained.`] : [])], limitations: LIMITATIONS
    };
  }
  // Compose execution and scope guards without copying mutable lifecycle flags.
  const screenshot = createNvdaEvidenceWriter(outputDir);
  const scopeWatch = createTabScopeWatch({ getPage: () => boundPage,
    isActive: () => !closed && !paused, runtime, canPause, enterPause, stop });
  const stateRunner = createLiveStateRunner({ nvda, runtime, emit, screenshot, recordWarning: (message) => warnings.push(message),
    requireTestTab, canPause, unlessPaused, enterPause, pausedError, stop,
    session: {
      get capture() { return capture; },
      get closed() { return closed; },
      get failure() { return failure; },
      get stoppedReason() { return stoppedReason; },
      get paused() { return paused; },
      get prepared() { return prepared; },
      get pauses() { return pauses; }
    }
  });
  return {
    preparePage, testState: stateRunner.testState, finish, close, resume, switchToPage,
    get state() { return closed || stoppedReason || failure ? "stopped" : paused ? "paused" : handoffComplete ? "testing" : "idle"; },
    get pausedReason() { return paused?.reason || null; },
    get recoveries() { return recoveries; }
  };
}
