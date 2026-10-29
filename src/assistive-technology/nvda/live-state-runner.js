import { randomBytes } from "node:crypto";
import { buildNvdaLivePlan, liveStateIdentity } from "./live-state-model.js";
import { selectNvdaAnnouncements } from "./speech.js";
import { annotateRequiredAnnouncement, requiredFieldSummary } from "../required-fields.js";

/**
 * Owns command execution, per-state retry history, and test evidence.
 * session exposes read-only live getters: async work must see current pause/
 * shutdown state, never a snapshot copied before an await.
 */
export function createLiveStateRunner({ nvda, runtime, session, emit, screenshot, recordWarning,
  requireTestTab, canPause, unlessPaused, enterPause, pausedError, stop }) {
  const states = [];
  const seen = new Set();
  const pausedIds = new Set();
  const pageMarkers = new WeakMap();
  let skipped = 0;
  let stateSequence = 0;
  let busy = false;
  const actionScreenshots = nvda.actionScreenshots === "all" ? "all" : "review";
  // Each state starts at the top; a retry skips only completed categories
  // belonging to that exact state's verified identity.
  async function testState(page, meta = {}) {
    const id = String(meta.id || meta.stateId || `${meta.url}|${meta.state}`);
    const previous = states.find((state) => state.id === id);
    if (seen.has(id) && !previous?.retryable) return previous || null;
    // A paused reader cannot test. Report it without consuming the state id,
    // a state-limit slot or a screenshot so the caller can resume and retry.
    if (session.paused && !session.closed) {
      pausedIds.add(id);
      if (previous) return previous;
      return {
        id, stateId: meta.stateId || id, state: meta.state || "default", url: meta.url || page.url(), title: meta.title || "",
        executionMode: meta.executionMode || "live-during-crawl", status: "paused", retryable: true, stateChanged: false, actions: [], evidence: null,
        reason: session.paused.reason, error: "NVDA was paused before this state was tested; retry it after NVDA resumes."
      };
    }
    seen.add(id);
    const stateLimit = Math.max(1, Math.min(1000, Number(nvda.maxStates) || 100));
    if (!previous && states.length >= stateLimit) { skipped++; return null; }
    const state = previous || {
      id, stateId: meta.stateId || id, state: meta.state || "default", url: meta.url || page.url(), title: meta.title || "",
      executionMode: meta.executionMode || "live-during-crawl", status: "blocked", stateChanged: false, actions: [], evidence: null,
      attempts: [], finishedChecks: [],
      checks: Object.fromEntries(["focus", "reading", "headings", "tables"].map((name) => [name, { status: "not-run", commands: 0 }] ))
    };
    state.checks.forms = { status: "not-configured", commands: 0, reason: "Form completion requires approved application test data and a workflow script." };
    state.checks.journeys = { status: "not-configured", commands: 0, reason: "No approved end-to-end user journey was configured." };
    if (!previous) states.push(state);
    // Each attempt gets distinct evidence; interruption never deletes history.
    const index = ++stateSequence;
    if (busy || session.closed || session.failure) {
      state.error = session.failure || session.stoppedReason || (session.closed ? "The NVDA session was closed." : "A live NVDA state test is already running.");
      state.evidence = await screenshot(page, index);
      return state;
    }
    busy = true;
    let cleanupNeeded = false;
    let expected;
    let resumeIdentityFailed = false;
    const pausesBefore = session.pauses.length;
    const stateStarted = Date.now();
    const startAt = "top";
    const firstAction = state.actions.length;
    state.retryable = false;
    delete state.interruptedByPause;
    delete state.error;
    delete state.reason;
    try {
      const window = session.prepared.get(page);
      if (!window) throw new Error("This browser page was not prepared for native NVDA input before application navigation.");
      await requireTestTab(page);
      const baseline = await runtime.inspect(page);
      expected = liveStateIdentity(baseline);
      if (state.identity && state.identity !== expected) {
        resumeIdentityFailed = true;
        state.stateChanged = true;
        throw new Error("The interrupted state's route or controls changed; saved commands cannot be resumed on this state.");
      }
      state.identity = expected;
      state.startedAt = startAt === "main" ? "main-content" : "document-top";
      // The tab marker identifies this owned session, not the changing state.
      // Native window captions may lag a same-tab dialog/title update; state
      // attribution is separately guarded by the live structural identity.
      if (!pageMarkers.has(page)) pageMarkers.set(page, randomBytes(6).toString("hex"));
      const title = `RAMBO NVDA ${session.capture.runId} ${pageMarkers.get(page)}`;
      await page.evaluate((value) => {
        const saved = { title: document.title, focus: document.activeElement, scrollX, scrollY };
        const observer = new MutationObserver(() => { if (document.title !== value) document.title = value; });
        window.__ramboNvdaLive = { ...saved, observer };
        document.title = value;
        observer.observe(document.head, { subtree: true, characterData: true, childList: true });
      }, title);
      cleanupNeeded = true;
      if (!await runtime.anchor(page, { startAt })) throw new Error("The live webpage could not receive keyboard focus.");
      const nativeFocus = await runtime.nativeAnchor(title, window.processId);
      if (!nativeFocus.ok) throw new Error(nativeFocus.reason || "Windows could not focus the testing document marker.");
      await requireTestTab(page);
      if (liveStateIdentity(await runtime.inspect(page)) !== expected) {
        state.stateChanged = true;
        throw new Error("Preparing focus changed a live dialog, tab or route; no test commands were sent.");
      }
      const enabled = new Set(nvda.tests || ["focus", "reading", "headings", "tables"]);
      for (const kind of ["focus", "reading", "headings", "tables"]) if (!enabled.has(kind)) state.checks[kind] = { status: "not-configured", commands: 0, reason: "This test category is disabled." };
      if (enabled.has("headings") && !baseline.headings) state.checks.headings = { status: "not-observed", commands: 0, reason: "No headings were found by the top-document inventory. Embedded or unsupported content still needs review." };
      if (enabled.has("tables") && !baseline.tables) state.checks.tables = { status: "not-observed", commands: 0, reason: "No tables were found by the top-document inventory. Embedded or unsupported content still needs review." };
      const skippedKinds = new Set();
      const startedKinds = new Set();
      let focusPrepared = false;
      emit({ type: "nvda", message: `Testing live state with NVDA: ${state.state}.`, url: state.url });
      const plan = buildNvdaLivePlan(nvda, baseline).filter((command) => !state.finishedChecks.includes(command.kind));
      for (const [planIndex, command] of plan.entries()) {
        await requireTestTab(page);
        if (skippedKinds.has(command.kind)) continue;
        const actionStarted = Date.now();
        if (liveStateIdentity(await runtime.inspect(page)) !== expected) { state.stateChanged = true; state.error = "A live route, dialog, selected tab or expanded control changed; remaining commands were stopped."; break; }
        let anchored = false;
        if (command.kind === "focus" && !focusPrepared) {
          if (!await runtime.anchor(page, { startAt })) throw new Error("Webpage focus could not be established for Tab traversal.");
          focusPrepared = true;
          anchored = true;
        }
        if (command.addonKind && !startedKinds.has(command.kind)) {
          if (!await runtime.anchor(page, { startAt })) throw new Error("Webpage focus could not be established for browse navigation.");
          anchored = true;
        }
        // Only re-check the state when this iteration actually moved focus.
        if (anchored && liveStateIdentity(await runtime.inspect(page)) !== expected) {
          state.stateChanged = true; state.error = "Preparing command focus changed the live state; no further commands were sent."; break;
        }
        const actionId = `${index}-${state.actions.length + 1}-${randomBytes(4).toString("hex")}`;
        session.capture.control.capture = { active: true, actionId, processId: window.processId, windowHandle: window.windowHandle, titleMarker: title };
        await session.capture.write();
        if (!await unlessPaused(session.capture.receiver.waitForCapture(actionId, 2500), false)) {
          if (session.stoppedReason || session.capture.stoppedReason || !canPause()) throw new Error(session.stoppedReason || session.capture.stoppedReason || "NVDA did not acknowledge the live capture window.");
          // A lost scope-paused report looks like an ack timeout. Pause so the
          // caller re-establishes the scope instead of ending the run.
          await enterPause(session.capture.receiver.paused?.reason || "NVDA did not acknowledge the live capture window.", "ack-timeout");
          throw session.paused ? pausedError() : new Error(session.stoppedReason || "The NVDA test session is closed.");
        }
        const armedAt = Date.now();
        await requireTestTab(page);
        const mark = session.capture.receiver.mark();
        let result;
        if (command.addonKind) {
          session.capture.control.capture.command = { id: actionId, kind: command.addonKind, maxDurationMs: command.maxDurationMs || 1500,
            resetPosition: !startedKinds.has(command.kind) };
          startedKinds.add(command.kind);
          await session.capture.write();
          result = await unlessPaused(session.capture.receiver.waitForCommand(actionId, (command.maxDurationMs || 2000) + 4000), { status: "blocked", reason: "NVDA paused before the command finished." });
          if (!result) result = { status: "blocked", reason: "NVDA command acknowledgement timed out; execution could not be confirmed." };
        } else {
          const sent = await runtime.sendTab(title, window.processId, Number(nvda.keyDelayMs || 450));
          result = { status: sent.ok ? "executed" : "blocked", reason: sent.reason };
          // Tab can legitimately leave a document for Chrome's toolbar. Only
          // an exact native HWND/PID/title check can classify that boundary.
          // No further keys or toolbar announcements are attributed to the site.
          if (sent.ok) {
            const scope = await runtime.nativeFocus(title, window.processId);
            if (scope.ok && scope.inDocument === false) {
              state.focusBoundary = "document-end";
              state.finishedChecks.push("focus");
              state.checks.focus.reason = "Tab reached browser chrome; webpage traversal ended without sending another key.";
              if (!state.checks.focus.commands) state.checks.focus.status = "not-observed";
              await enterPause("Tab reached the end of the website document.", "document-end");
              if (session.paused) session.paused.documentBoundaryVerified = true;
              throw pausedError();
            }
          }
        }
        const commandDoneAt = Date.now();
        const action = { index: state.actions.length + 1, kind: command.kind, command: command.command, status: result.status, reason: result.reason, announcements: [], focus: null, outcome: "needs-review" };
        if (command.kind === "reading") action.readingCompletion = result.readingCompletion || "unconfirmed";
        state.actions.push(action);
        const speech = ["executed", "partial"].includes(result.status) ? await unlessPaused(runtime.speechWait(session.capture.receiver, mark, actionId, Number(nvda.announcementWaitMs || 650), {
          audibleCompletion: nvda.fastSpeech !== true && command.kind !== "reading",
          // Reading commands can legitimately pause before speaking.
          silentWaitMs: command.kind === "reading" ? 0 : nvda.silentWaitMs
        }), null) : null;
        if (speech?.silent) {
          action.reason = [action.reason, `NVDA announced nothing within the ${speech.settledMs} ms silent wait (NVDA_SILENT_WAIT_MS); confirm the silence by ear if it matters.`].filter(Boolean).join(" ");
          action.silentCutoff = true;
        } else if (speech?.audibleComplete === false) {
          action.reason = [action.reason, "The announcement did not confirm audible completion within the bounded wait; review the audio."].filter(Boolean).join(" ");
        }
        if (speech?.audibleComplete !== undefined) action.audibleComplete = speech.audibleComplete;
        if (command.kind === "reading") action.audibleComplete = result.readingCompletion === "completed" && result.audibleComplete === true;
        const speechDoneAt = Date.now();
        const events = session.capture.receiver.since(mark).filter((entry) => entry.actionId === actionId);
        action.announcements = command.addonKind ? events.filter((entry) => entry.inDocument && !entry.isFocusAnchor).map((entry) => entry.text).filter(Boolean) : selectNvdaAnnouncements(events);
        session.capture.control.capture = { active: false };
        await session.capture.write();
        const disarmedAt = Date.now();
        action.focus = await runtime.describe(page);
        action.stateChanged = liveStateIdentity(await runtime.inspect(page)) !== expected;
        action.outcome = action.announcements.length && !action.stateChanged && result.status === "executed" && speech?.audibleComplete !== false ? "announced" : "needs-review";
        if (command.kind === "reading" && !action.audibleComplete) action.outcome = "needs-review";
        if (command.kind === "reading" && action.stateChanged) action.readingCompletion = "interrupted";
        annotateRequiredAnnouncement(action);
        // Announced stops are evidenced by their transcript and focus record; a
        // screenshot is kept where a reviewer has to look (or for every stop
        // with NVDA_ACTION_SCREENSHOTS=all).
        action.evidence = actionScreenshots === "all" || action.outcome !== "announced"
          ? await screenshot(page, index, `-action-${String(action.index).padStart(2, "0")}`) : null;
        // Where each command's time went, so slow runs can be diagnosed.
        action.timing = {
          armMs: armedAt - actionStarted, commandMs: commandDoneAt - armedAt,
          firstSpeechMs: speech?.firstSpeechMs ?? null, speechMs: speechDoneAt - commandDoneAt,
          disarmMs: disarmedAt - speechDoneAt, inspectMs: Date.now() - disarmedAt, totalMs: Date.now() - actionStarted
        };
        const check = state.checks[command.kind];
        check.commands += ["executed", "partial"].includes(result.status) ? 1 : 0;
        const nextStatus = result.status === "partial" ? "partial" : result.status === "executed" ? (action.outcome === "announced" ? "executed" : "needs-review") : result.status;
        const severity = { "not-run": 0, executed: 1, partial: 2, "needs-review": 3, skipped: 4, blocked: 5 };
        if ((severity[nextStatus] ?? 3) >= (severity[check.status] ?? 0)) check.status = nextStatus;
        if (action.reason) check.reason = action.reason;
        if (["skipped", "blocked"].includes(result.status)) skippedKinds.add(command.kind);
        if (!session.paused && (plan[planIndex + 1]?.kind !== command.kind || skippedKinds.has(command.kind))) state.finishedChecks.push(command.kind);
        if (action.stateChanged) { state.stateChanged = true; state.error = "NVDA navigation changed a live route, dialog, selected tab or expanded control; review the transition."; break; }
      }
    } catch (error) {
      if (error?.code === "NVDA_PAUSED") state.interruptedByPause = true;
      state.error = String(error.message || error);
      if (expected) state.stateChanged ||= await runtime.inspect(page).then((value) => liveStateIdentity(value) !== expected).catch(() => true);
    }
    finally {
      if (session.capture) {
        session.capture.control.capture = { active: false };
        try { await session.capture.write(); }
        catch (error) {
          // Never restore the site's title with an unacknowledged armed reader.
          // Shut down the owned process before cleaning up the temporary scope.
          await stop(`NVDA capture could not be disarmed safely: ${error.message}`, "disarm-failed");
        }
      }
      const interrupted = Boolean(resumeIdentityFailed || state.interruptedByPause || session.pauses.length > pausesBefore);
      state.evidence = await screenshot(page, index) || state.evidence;
      if (cleanupNeeded) await page.evaluate(() => {
        const saved = window.__ramboNvdaLive;
        saved?.observer?.disconnect();
        document.getElementById("rambo-nvda-focus-anchor")?.remove();
        if (saved) {
          document.title = saved.title;
          if (saved.focus?.isConnected) saved.focus.focus?.({ preventScroll: true });
          window.scrollTo(saved.scrollX, saved.scrollY);
        }
        delete window.__ramboNvdaLive;
      }).catch(() => {});
      if (interrupted) {
        pausedIds.add(id);
        Object.assign(state, { status: "interrupted", retryable: Boolean(session.paused && !session.closed && !state.stateChanged), interruptedByPause: true,
          reason: session.paused?.reason || session.stoppedReason || state.error || "NVDA testing was interrupted.",
          error: "NVDA was interrupted. Completed checks and available speech are retained; remaining checks were not completed." });
      } else {
        if (expected) state.stateChanged ||= await runtime.inspect(page).then((value) => liveStateIdentity(value) !== expected).catch(() => true);
        const executed = state.actions.filter((action) => ["executed", "partial"].includes(action.status));
        state.status = executed.length ? "executed" : "blocked";
        state.summary = { commands: executed.length, announced: executed.filter((action) => action.announcements.length).length, needsReview: state.actions.filter((action) => action.outcome === "needs-review").length };
        if (state.error) recordWarning(`${state.url} [${state.state}]: ${state.error}`);
        pausedIds.delete(id);
      }
      const recorded = state.actions.filter((action) => ["executed", "partial"].includes(action.status));
      state.checks.requiredFields = requiredFieldSummary(state.actions);
      state.summary = { commands: recorded.length, announced: recorded.filter((action) => action.announcements.length).length,
        needsReview: state.actions.filter((action) => action.outcome === "needs-review").length };
      state.durationMs = (state.durationMs || 0) + Date.now() - stateStarted;
      state.attempts.push({ status: state.status, reason: state.reason || state.error || null,
        startedAt: new Date(stateStarted).toISOString(), endedAt: new Date().toISOString(), firstAction: firstAction + 1,
        actionCount: state.actions.length - firstAction, evidence: state.evidence });
      busy = false;
    }
    return state;
  }
  return {
    testState,
    get busy() { return busy; },
    results() { return { states, seen, pausedIds, skipped }; }
  };
}
