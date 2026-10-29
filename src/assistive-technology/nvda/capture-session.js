import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { detectNvdaCapability } from "./capability.js";
import { createNvdaCaptureReceiver } from "./capture-receiver.js";
import { stopNvda, startNvda } from "./process.js";
import { probeNvdaRunning, startKeyHelper, closeKeyHelper } from "./native-keyboard.js";
import { writeControlFile } from "./control-file.js";
import { keyServerScript } from "./paths.js";
import { desktopLease } from "./desktop-lease.js";

// Both runners share this desktop lease. The live runner owns only the reader
// it launches; a pre-existing user reader is never stopped.
export async function startNvdaCaptureSession({ config, outputDir, emit = () => {}, signal, browserScope, startupHandoff = false }) {
  if (signal?.aborted) throw new Error("The test tab closed before NVDA startup.");
  if (desktopLease.active) throw new Error("Another NVDA test is using this Windows desktop session.");
  const availability = detectNvdaCapability(config.nvda || {});
  if (!availability.available) throw new Error(availability.reason);
  desktopLease.active = true;
  // Start the keyboard helper now so its one-time startup overlaps NVDA's.
  if (process.platform === "win32" && fs.existsSync(keyServerScript)) startKeyHelper();
  const runId = `nvda-live-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const profilePath = path.resolve(config.nvda.configPath);
  const controlFile = path.join(profilePath, "accessibilityAgentCapture.json");
  let receiver;
  let started = false;
  let closed = false;
  let launchedPid;
  let controlWritten = false;
  let heartbeat;
  let shutdownComplete = false;
  let shutdownError = null;
  let launchPending;
  let closePending;
  let pendingWrite = Promise.resolve();
  const enqueueWrite = (value, acknowledgeDisarm = false) => {
    const snapshot = structuredClone(value);
    if (acknowledgeDisarm && !snapshot.capture?.active) snapshot.disarmId = randomBytes(8).toString("hex");
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      await writeControlFile(controlFile, snapshot);
      if (snapshot.disarmId && !await receiver.waitForDisarm(snapshot.disarmId, 2000)) throw new Error("NVDA did not acknowledge capture shutdown.");
    });
    return pendingWrite;
  };
  const startupTimeoutMs = Math.max(1000, Math.min(300_000, Number(config.nvda.startupTimeoutMs) || 60_000));
  const configuredSpeechRate = Number(config.nvda?.speechRate ?? 40);
  const control = { runId, agentOwnsReader: true, fastSpeech: config.nvda?.fastSpeech === true,
    speechRate: Number.isFinite(configuredSpeechRate) ? Math.max(0, Math.min(100, Math.trunc(configuredSpeechRate))) : 40, capture: { active: false },
    ...(startupHandoff ? { lifecycle: "initializing", startupDeadlineMs: Date.now() + startupTimeoutMs + 10_000 } : {}),
    ...(browserScope ? { browserScope: { processId: Number(browserScope.processId), windowHandle: String(browserScope.windowHandle) } } : {}) };
  const close = () => {
    if (closePending) return closePending;
    closed = true;
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", onAbort);
    closeKeyHelper();
    closePending = (async () => {
      if (receiver && controlWritten) await enqueueWrite({ ...control, capture: { active: false }, stopRequested: true }).catch(() => {});
      if (launchPending && !started) {
        const launch = await launchPending.catch(() => null);
        if (launch) { launchedPid = launch.pid || launch.process?.pid; started = true; }
      }
      if (started) {
        await receiver.waitForScopeStopped(2_500);
        const stopped = stopNvda(availability.executable, receiver.readerProcessId || launchedPid);
        if (!stopped.ok) shutdownError = `NVDA process shutdown could not be confirmed: ${stopped.reason}`;
      }
      await receiver?.close().catch(() => {});
      if (controlWritten) await fsp.rm(controlFile, { force: true }).catch(() => {});
      desktopLease.active = false;
      shutdownComplete = !shutdownError;
    })();
    return closePending;
  };
  const onAbort = () => { void close(); };
  try {
    if (startupHandoff && !browserScope) throw new Error("The startup handoff requires a verified testing Chrome window.");
    if (browserScope && (!Number.isInteger(control.browserScope.processId) || control.browserScope.processId <= 0 || !/^\d+$/.test(control.browserScope.windowHandle) || BigInt(control.browserScope.windowHandle) <= 0n)) throw new Error("The testing Chrome window scope was not verified; NVDA was not launched.");
    if (await probeNvdaRunning()) throw new Error("NVDA is already running. Exit it manually first; this test must launch and own the reader that closes with its tab.");
    await Promise.all([fsp.mkdir(path.join(outputDir, "nvda"), { recursive: true }), fsp.mkdir(profilePath, { recursive: true })]);
    receiver = await createNvdaCaptureReceiver({ maxEvents: 10_000 });
    Object.assign(control, { endpoint: receiver.endpoint, token: receiver.token });
    await enqueueWrite(control);
    controlWritten = true;
    // Cold NVDA initialization can exceed a single 45-second lease. Keep the
    // authenticated, inactive scope alive while starting, not just after ready.
    heartbeat = setInterval(() => { if (!closed) void enqueueWrite(control).catch(() => {}); }, 10_000);
    heartbeat.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) throw new Error("The test tab closed before NVDA startup.");
    emit({ type: "nvda", message: "Starting NVDA for the focused testing tab; continuing as soon as its add-on is ready." });
    // An event consumer may synchronously cancel the scan. Do not launch a
    // process after its abort handler has already completed cleanup.
    if (closed || signal?.aborted) throw new Error("The test tab closed before NVDA startup.");
    launchPending = startNvda(availability.executable, profilePath, path.join(outputDir, "nvda", "nvda.log"), runId);
    const launch = await launchPending;
    launch.process?.unref?.();
    launchedPid = launch.pid || launch.process?.pid;
    started = true;
    if (closed || signal?.aborted) throw new Error("The test tab closed during NVDA startup.");
    emit({ type: "nvda", message: "Connecting NVDA to the headed crawl browser." });
    if (!await receiver.waitForReady(startupTimeoutMs)) {
      throw new Error(`NVDA did not finish connecting within ${startupTimeoutMs / 1000} seconds. The installed test profile was detected; check nvda/nvda.log for slow or blocked initialization.`);
    }
    if (receiver.protocolVersion < 6 || !receiver.initialized || receiver.speechScope !== "test-tab" || !receiver.agentOwnsReader) throw new Error("Update the NVDA add-on for startup readiness and test-tab shutdown. Run npm run install:nvda-addon and exit NVDA before retrying.");
    if (closed || signal?.aborted) throw new Error("The test tab closed during NVDA startup.");
    // Older add-ons exit on any focus loss and must never be asked to pause.
    // The next write (the startup handoff) carries the opt-in.
    if (receiver.pauseSupported) control.pauseResume = true;
    return { runId, receiver, control, close, get closed() { return closed; }, get shutdownComplete() { return shutdownComplete; }, get shutdownError() { return shutdownError; }, get stoppedReason() { return receiver.stoppedReason; }, write: () => closed ? Promise.reject(new Error("NVDA session is closed.")) : enqueueWrite(control, true) };
  } catch (error) {
    await close();
    throw error;
  }
}
