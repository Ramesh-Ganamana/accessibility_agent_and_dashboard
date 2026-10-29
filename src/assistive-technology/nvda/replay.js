import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { captureApplicationState } from "../../scanner/actions.js";
import { nvdaStateIdentity, restoreNvdaState, selectNvdaStates } from "../state-targets.js";
import { installActionExclusions } from "../../browser/action-exclusions.js";
import { annotateRequiredAnnouncement, requiredFieldSummary } from "../required-fields.js";
import { detectNvdaCapability } from "./capability.js";
import { selectNvdaAnnouncements, waitForActionSpeech } from "./speech.js";
import { createNvdaCaptureReceiver } from "./capture-receiver.js";
import { checkNvdaRunning, stopNvda, startNvda } from "./process.js";
import { focusAndMaximizeBrowser, sendNativeTab, prepareNativeDocumentFocus, closeKeyHelper } from "./native-keyboard.js";
import { launchHeadedBrowser, keepWindowTitle, establishPageKeyboardFocus, describeFocusedElement } from "./browser-focus.js";
import { writeControlFile } from "./control-file.js";
import { unavailable, firstLine } from "./text.js";
import { desktopLease } from "./desktop-lease.js";

export async function runNvdaWebsiteTest({ report, config, storageState, stateTargets, outputDir, emit = () => {} }) {
  if (desktopLease.active) return unavailable("blocked", "Another NVDA website test is already using this Windows desktop session.");
  const nvdaConfig = config.nvda || {};
  const selection = selectNvdaStates(report, stateTargets, nvdaConfig.maxStates);
  const targets = selection.targets;
  const pendingCoverage = { statesDiscovered: selection.discovered, statesSelected: targets.length, statesSkippedByLimit: selection.skippedByLimit, statesAttempted: 0, statesExecuted: 0, keyboardCommands: 0, announcementsCaptured: 0 };
  if (!targets.length) return unavailable("blocked", "No successfully captured same-origin states are available for NVDA testing.", { coverage: pendingCoverage });
  const availability = detectNvdaCapability(nvdaConfig);
  if (!availability.available) return unavailable("unavailable", availability.reason, { coverage: pendingCoverage });

  desktopLease.active = true;
  const startedAt = new Date().toISOString();
  const runId = `nvda-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const profilePath = path.resolve(nvdaConfig.configPath);
  const logDir = path.join(outputDir, "nvda");
  const evidenceDir = path.join(outputDir, "evidence", "nvda");
  const controlFile = path.join(profilePath, "accessibilityAgentCapture.json");
  let receiver;
  let browser;
  let nvdaProcess;
  let launchedPid;
  let startedNvda = false;

  try {
    if (checkNvdaRunning(availability.executable)) throw new Error("NVDA is already running. Exit the manually started reader first so this test can own and stop its NVDA process.");
    await fsp.mkdir(profilePath, { recursive: true });
    await fsp.mkdir(logDir, { recursive: true });
    await fsp.mkdir(evidenceDir, { recursive: true });
    receiver = await createNvdaCaptureReceiver();
    const control = {
      runId,
      agentOwnsReader: true,
      fastSpeech: nvdaConfig.fastSpeech === true,
      speechRate: Math.max(0, Math.min(100, Number(nvdaConfig.speechRate ?? 40))),
      endpoint: receiver.endpoint,
      token: receiver.token,
      capture: { active: false }
    };
    await writeControlFile(controlFile, control);

    emit({ type: "nvda", message: "Preparing the actual NVDA website test in a headed Windows browser." });
    const running = checkNvdaRunning(availability.executable);
    if (!running) {
      const launch = await startNvda(availability.executable, profilePath, path.join(logDir, "nvda.log"), runId);
      nvdaProcess = launch.process;
      launchedPid = launch.pid;
      nvdaProcess?.unref?.();
      if (launch.mode === "powershell-fallback") {
        emit({ type: "nvda", message: "Windows blocked the direct NVDA child process, so the guarded PowerShell launcher was used." });
      }
      startedNvda = true;
    }

    const ready = await receiver.waitForReady(Number(nvdaConfig.startupTimeoutMs || 20_000));
    if (!ready) {
      const reason = running
        ? "NVDA is already running without the RAMBO capture profile. Close it and retry from the dedicated test session."
        : "The NVDA capture add-on did not connect. Install the included add-on into the configured NVDA profile and restart the scan.";
      return unavailable("blocked", reason, { startedAt, completedAt: new Date().toISOString(), version: receiver.version, coverage: pendingCoverage });
    }
    if (receiver.protocolVersion < 5 || receiver.speechScope !== "test-tab") {
      return unavailable("blocked", "The NVDA capture add-on is outdated. Run npm run install:nvda-addon, close NVDA, and retry.", { startedAt, completedAt: new Date().toISOString(), coverage: pendingCoverage });
    }

    browser = await launchHeadedBrowser(config.browserChannel);
    const context = await browser.newContext({
      viewport: null,
      ignoreHTTPSErrors: true,
      locale: "en-US",
      ...(storageState ? { storageState } : {})
    });
    // The replay browser applies the same Do not click list as the crawl.
    await installActionExclusions(context, config);
    const stateResults = [];
    const warnings = [];
    if (selection.skippedByLimit) warnings.push(`${selection.skippedByLimit} captured state(s) were not tested because the NVDA state limit was reached.`);

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const stateInfo = { id: target.id, stateId: target.stateId, state: target.state, url: target.url, title: target.title };
      let page;
      const actions = [];
      const warningPrefix = `${target.url} [${target.state}]:`;
      const stateWarningStart = warnings.length;
      emit({ type: "nvda", message: `NVDA is replaying state ${index + 1}/${targets.length}: ${target.state} on ${target.url}.`, url: target.url });
      try {
        page = await context.newPage();
        const windowTitle = `RAMBO NVDA ${runId} ${index + 1}`;
        // Acquire Windows renderer focus before loading application content so
        // the setup shortcuts cannot dismiss an auto-open application overlay.
        await page.setContent('<!doctype html><html><head><title>NVDA preparation</title></head><body><button type="button">Prepare document focus</button></body></html>');
        await keepWindowTitle(page, windowTitle);
        await page.bringToFront();
        const expectedWindow = await focusAndMaximizeBrowser(windowTitle);
        if (!expectedWindow.ok) throw new Error(expectedWindow.reason);
        const prepared = await prepareNativeDocumentFocus(windowTitle, expectedWindow.processId);
        if (!prepared.ok) throw new Error(prepared.reason);
        await restoreNvdaState(page, target, {
          excludeLabels: config.excludeActionLabels || [],
          beforeReplay: async () => {
            await keepWindowTitle(page, windowTitle);
            if (!await establishPageKeyboardFocus(page)) throw new Error("The webpage could not receive keyboard focus before state replay.");
          }
        });
        // Replay may navigate. Restore the marker, but do not click outside an
        // opened menu/dialog or send toolbar keys that would dismiss this state.
        await keepWindowTitle(page, windowTitle);
        await page.waitForTimeout(700);
        const restoredIdentity = target.identity || nvdaStateIdentity(await captureApplicationState(page));
        const tabStops = Math.max(1, Math.min(30, Number(nvdaConfig.tabStops || 12)));

        for (let tabIndex = 0; tabIndex < tabStops; tabIndex += 1) {
          const window = expectedWindow;
          const pageFocusReady = await page.evaluate(() => document.hasFocus()).catch(() => false);
          if (!pageFocusReady) {
            warnings.push(`${warningPrefix} Webpage focus was lost. Testing stopped without changing the captured state to regain focus.`);
            break;
          }
          if (nvdaStateIdentity(await captureApplicationState(page)) !== restoredIdentity) {
            warnings.push(`${warningPrefix} The application state changed before the next command; remaining commands were not attributed to this state.`);
            break;
          }
          await page.waitForTimeout(100);
          const actionStarted = Date.now();
          const actionId = `${index + 1}-${tabIndex + 1}-${randomBytes(4).toString("hex")}`;
          control.capture = {
            active: true,
            actionId,
            processId: window.processId,
            windowHandle: window.windowHandle,
            titleMarker: windowTitle
          };
          await writeControlFile(controlFile, control);
          const captureReady = await receiver.waitForCapture(actionId, 2_000);
          if (!captureReady) {
            warnings.push(`${warningPrefix} NVDA did not acknowledge capture action ${tabIndex + 1}.`);
            control.capture = { active: false };
            await writeControlFile(controlFile, control);
            break;
          }
          const before = receiver.mark();
          const sent = await sendNativeTab(windowTitle, window.processId, Number(nvdaConfig.keyDelayMs || 450));
          if (!sent.ok) {
            warnings.push(`${warningPrefix} ${sent.reason}`);
            control.capture = { active: false };
            await writeControlFile(controlFile, control);
            break;
          }
          const action = { index: tabIndex + 1, kind: "focus", status: "executed", command: "Tab", announcements: [], focus: null, capture: null, outcome: "needs-review" };
          actions.push(action); // A sent key remains recorded even if inspection fails.
          const keySentAt = Date.now();
          const speech = await waitForActionSpeech(receiver, before, actionId, Number(nvdaConfig.announcementWaitMs || 650), { audibleCompletion: nvdaConfig.fastSpeech !== true, silentWaitMs: nvdaConfig.silentWaitMs });
          action.timing = { armAndKeyMs: keySentAt - actionStarted, firstSpeechMs: speech?.firstSpeechMs ?? null, speechSettledMs: Date.now() - keySentAt, ...(speech?.silent ? { silentCutoffMs: speech.settledMs } : {}) };
          const captured = receiver.since(before).filter((entry) => entry.actionId === actionId);
          action.announcements = selectNvdaAnnouncements(captured);
          action.capture = captured[0] ? { foregroundProcessId: captured[0].foregroundProcessId, focusProcessId: captured[0].focusProcessId } : null;
          control.capture = { active: false };
          await writeControlFile(controlFile, control);
          const focus = await describeFocusedElement(page);
          action.focus = focus;
          const stateChanged = nvdaStateIdentity(await captureApplicationState(page)) !== restoredIdentity;
          action.stateChanged = stateChanged;
          action.audibleComplete = speech?.audibleComplete;
          action.outcome = action.announcements.length && focus.documentFocused && !stateChanged ? "announced" : "needs-review";
          annotateRequiredAnnouncement(action);
          if (stateChanged) {
            warnings.push(`${warningPrefix} Tab changed or dismissed the captured state. Its transition requires review; remaining commands were stopped.`);
            break;
          }
        }

        let evidence = path.posix.join("evidence", "nvda", `${String(index + 1).padStart(3, "0")}-nvda-focus.png`);
        try {
          await page.screenshot({ path: path.join(outputDir, ...evidence.split("/")), fullPage: false });
        } catch {
          evidence = null;
          warnings.push(`${warningPrefix} The evidence screenshot could not be saved; completed keyboard actions are retained.`);
        }
        const reviewStops = actions.filter((action) => action.outcome === "needs-review").length;
        if (reviewStops) warnings.push(`${warningPrefix} ${reviewStops} keyboard focus stop(s) require review for speech, focus, or state changes.`);
        stateResults.push({
          ...stateInfo,
          stateRestored: true,
          status: actions.length ? "executed" : "blocked",
          evidence,
          actions,
          checks: { requiredFields: requiredFieldSummary(actions) },
          error: actions.length ? undefined : warnings.slice(stateWarningStart).join(" ") || "No keyboard action could be completed in the restored state.",
          summary: {
            commands: actions.length,
            announced: actions.length - reviewStops,
            needsReview: reviewStops
          }
        });
      } catch (error) {
        control.capture = { active: false };
        await writeControlFile(controlFile, control).catch(() => {});
        const message = firstLine(error?.message || error);
        warnings.push(`${warningPrefix} ${message}`);
        stateResults.push({ ...stateInfo, status: actions.length ? "executed" : "blocked", actions, error: message });
      } finally {
        await page?.close().catch(() => {});
      }
    }

    await context.close().catch(() => warnings.push("Browser cleanup failed; completed NVDA state results were retained."));
    const actions = stateResults.flatMap((entry) => entry.actions || []);
    const announcements = actions.reduce((sum, action) => sum + action.announcements.length, 0);
    const needsReview = actions.filter((action) => action.outcome === "needs-review").length;
    return {
      product: "NVDA",
      actualExecution: actions.length > 0,
      status: stateResults.some((entry) => entry.status === "executed") ? "executed" : "blocked",
      outcome: !actions.length ? "not-executed" : warnings.length || needsReview ? "needs-review" : "completed",
      version: receiver.version || "unknown",
      browser: config.browserChannel || "Playwright Chromium",
      startedAt,
      completedAt: new Date().toISOString(),
      coverage: {
        mode: "headed-windows-state-keyboard-focus",
        statesDiscovered: selection.discovered,
        statesSelected: targets.length,
        statesAttempted: stateResults.length,
        statesExecuted: stateResults.filter((entry) => entry.status === "executed").length,
        statesSkippedByLimit: selection.skippedByLimit,
        keyboardCommands: actions.length,
        announcementsCaptured: announcements,
        needsReview
      },
      states: stateResults,
      warnings,
      limitations: [
        "This first NVDA integration covers actual Tab focus announcements in a maximized headed Windows browser, gated to that browser's foreground process for each command.",
        "Captured states are replayed through safe actions and checked before testing. Dynamic or unreplayable states are blocked, not substituted with a default page; keyboard transitions require review.",
        "It does not yet prove NVDA browse-mode shortcuts, virtual-cursor reading, table navigation, form completion, or end-to-end task usability.",
        "Human testing by an experienced NVDA user is still required before making a conformance claim."
      ]
    };
  } catch (error) {
    return unavailable("blocked", firstLine(error?.message || error), { startedAt, completedAt: new Date().toISOString(), coverage: pendingCoverage });
  } finally {
    closeKeyHelper();
    await browser?.close().catch(() => {});
    await receiver?.close().catch(() => {});
    await fsp.rm(controlFile, { force: true }).catch(() => {});
    if (startedNvda) stopNvda(availability.executable, receiver?.readerProcessId || launchedPid || nvdaProcess?.pid);
    desktopLease.active = false;
  }
}
