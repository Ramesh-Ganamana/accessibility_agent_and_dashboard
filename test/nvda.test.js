import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import { checkNvdaRunning, createNvdaCaptureReceiver, detectNvdaCapability, probeNvdaRunning, runNvdaWebsiteTest, runPowerShellHelper, selectNvdaAnnouncements, waitForActionSpeech, writeControlFile } from "../src/assistive-technology/nvda.js";
import { selectNvdaStates } from "../src/assistive-technology/state-targets.js";

async function receiverFixture(context) {
  const receiver = await createNvdaCaptureReceiver();
  context.after(() => receiver.close());
  const post = (payload) => fetch(receiver.endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", "X-RAMBO-Token": receiver.token },
    body: JSON.stringify(payload)
  });
  try {
    assert.equal((await post({})).status, 204);
  } catch (error) {
    if (error?.cause?.code === "EACCES") {
      context.skip("This sandbox blocks loopback client connections; run the NVDA tests outside the sandbox.");
      return null;
    }
    throw error;
  }
  return { receiver, post };
}

test("protocol 6 startup readiness requires the completed NVDA initialization signal", async (context) => {
  const f = await receiverFixture(context);
  if (!f) return;
  const ready = { type: "ready", version: "fixture-6", protocolVersion: 6, speechScope: "test-tab", readerProcessId: 123, agentOwnsReader: true };
  for (const incomplete of [ready, { ...ready, initialized: false }, { ...ready, initialized: "true" }]) {
    assert.equal((await f.post(incomplete)).status, 204);
    assert.equal(await f.receiver.waitForReady(20), false, "Global-plugin initialization alone must not allow application navigation.");
    assert.notEqual(f.receiver.initialized, true);
  }
  const pending = f.receiver.waitForReady(1000);
  assert.equal((await f.post({ ...ready, initialized: true })).status, 204);
  assert.equal(await pending, true);
  assert.equal(f.receiver.initialized, true);
  assert.equal(f.receiver.protocolVersion, 6);
});

test("NVDA reports audible-completion support only after the add-on advertises it", async (context) => {
  const f = await receiverFixture(context);
  if (!f) return;
  assert.equal(f.receiver.audioCompletionSupported, false);
  const ready = { type: "ready", version: "fixture-7", protocolVersion: 7, speechScope: "test-tab", readerProcessId: 123, agentOwnsReader: true, initialized: true };
  await f.post(ready);
  assert.equal(f.receiver.audioCompletionSupported, false, "A transcript-capable reader is not evidence that audible completion can be observed.");
  await f.post({ ...ready, capabilities: ["audible-completion"] });
  assert.equal(f.receiver.audioCompletionSupported, true);
});

test("NVDA transcripts do not finish the audible wait and idle acknowledgements require authentication and matching action", async (context) => {
  const f = await receiverFixture(context);
  if (!f) return;
  await f.post({ type: "speech", actionId: "current-action", speechSequence: 4, text: "Account overview heading", inDocument: true });
  const events = f.receiver.since(0);
  assert.equal(events[0].speechSequence, 4);
  let completed = false;
  const pending = f.receiver.waitForSpeechIdle("current-action", 4, 1000).then((value) => { completed = true; return value; });
  assert.equal(completed, false, "Speech submission must not be mistaken for the speaker finishing.");
  const idle = { type: "speech-idle", actionId: "current-action", speechSequence: 4, audibleComplete: true };
  const denied = await fetch(f.receiver.endpoint, {
    method: "POST", headers: { "X-RAMBO-Token": "wrong-token" }, body: JSON.stringify(idle)
  });
  assert.equal(denied.status, 403);
  for (const invalid of [
    { ...idle, actionId: "previous-action" },
    { ...idle, audibleComplete: undefined },
    { ...idle, audibleComplete: "true" },
    { ...idle, speechSequence: 3 },
    { ...idle, speechSequence: "4" }
  ]) await f.post(invalid);
  assert.equal(completed, false, "Unconfirmed, stale, or unrelated speech must not release the next keyboard command.");
  await f.post(idle);
  assert.equal(await pending, true);
});

test("NVDA remembers audible completion but later speech invalidates the previous idle acknowledgement", async (context) => {
  const f = await receiverFixture(context);
  if (!f) return;
  await f.post({ type: "speech", actionId: "action-1", speechSequence: 1, text: "First announcement", inDocument: true });
  await f.post({ type: "speech-idle", actionId: "action-1", speechSequence: 1, audibleComplete: true });
  assert.equal(await f.receiver.waitForSpeechIdle("action-1", 1, 20), true, "Completion arriving before its waiter must be retained.");
  await f.post({ type: "speech", actionId: "action-1", speechSequence: 2, text: "Second announcement", inDocument: true });
  let completed = false;
  const pending = f.receiver.waitForSpeechIdle("action-1", 1, 1000).then((value) => { completed = true; return value; });
  await f.post({ type: "speech-idle", actionId: "action-1", speechSequence: 1, audibleComplete: true });
  assert.equal(completed, false, "The requested minimum cannot bypass later queued speech for the same command.");
  await f.post({ type: "speech-idle", actionId: "action-1", speechSequence: 2, audibleComplete: true });
  assert.equal(await pending, true);
  assert.equal(await f.receiver.waitForSpeechIdle("never-spoken", 1, 20), false);
});

test("NVDA audible-completion waiters cancel when test scope stops or the receiver closes", async (context) => {
  const f = await receiverFixture(context);
  if (!f) return;
  const stoppedWait = f.receiver.waitForSpeechIdle("pending-action", 1, 1000);
  await f.post({ type: "scope-stopped", reason: "Testing tab was closed" });
  assert.equal(await stoppedWait, false);
  assert.equal(await f.receiver.waitForSpeechIdle("pending-action", 1, 20), false);
  const other = await receiverFixture(context);
  if (!other) return;
  const closedWait = other.receiver.waitForSpeechIdle("pending-action", 1, 1000);
  await other.receiver.close();
  assert.equal(await closedWait, false);
});

test("listener-friendly NVDA action waits beyond transcript quiet time until speech finishes", async (context) => {
  const f = await receiverFixture(context);
  if (!f) return;
  await f.post({ type: "ready", version: "fixture-7", protocolVersion: 7, speechScope: "test-tab", readerProcessId: 123, agentOwnsReader: true, initialized: true, capabilities: ["audible-completion"] });
  const mark = f.receiver.mark();
  let completed = false;
  const pending = waitForActionSpeech(f.receiver, mark, "readable-action", 100, { audibleCompletion: true, audioTimeoutMs: 1500 }).then((value) => { completed = true; return value; });
  await f.post({ type: "speech", actionId: "readable-action", speechSequence: 8, text: "A longer spoken announcement", inDocument: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(completed, false, "The old 250 ms transcript quiet interval must not cut off audible speech.");
  await f.post({ type: "speech-idle", actionId: "readable-action", speechSequence: 8, audibleComplete: true });
  const result = await pending;
  assert.equal(result.audibleComplete, true);
});

test("NVDA silent wait ends early only when nothing at all was announced", async () => {
  const events = [];
  const receiver = { stoppedReason: null, since: () => events, waitForSpeech: (ms) => new Promise((resolve) => setTimeout(() => resolve(false), ms)) };
  let started = Date.now();
  const silent = await waitForActionSpeech(receiver, 0, "quiet-action", 650, { audibleCompletion: true, silentWaitMs: 300 });
  assert.equal(silent.silent, true);
  assert.ok(Date.now() - started < 1_000, "A silent stop ends at the configured silent wait, not the full wait.");

  started = Date.now();
  const full = await waitForActionSpeech(receiver, 0, "quiet-action", 650, {});
  assert.equal(full.silent, undefined, "Without NVDA_SILENT_WAIT_MS the full bounded wait is kept.");
  assert.ok(Date.now() - started >= 1_800);

  setTimeout(() => events.push({ actionId: "late-action", text: "Menu" }), 200);
  setTimeout(() => events.push({ actionId: "late-action", text: "button" }), 400);
  const spoken = await waitForActionSpeech(receiver, 0, "late-action", 650, { silentWaitMs: 300 });
  assert.equal(spoken.silent, undefined, "Speech that has started is never cut short by the silent wait.");
  assert.equal(events.filter((entry) => entry.actionId === "late-action").length, 2);
  assert.ok(spoken.firstSpeechMs >= 150 && spoken.firstSpeechMs <= 450, "The fake receiver only notices speech when its wait expires.");
});

test("strict scope handoff acknowledges only the matching authenticated scope ID", async (context) => {
  const f = await receiverFixture(context);
  if (!f) return;
  assert.equal((await f.post({ type: "scope-ready", scopeId: "current-scope" })).status, 204);
  assert.equal(await f.receiver.waitForScope("current-scope", 20), false, "A premature scope acknowledgement cannot bypass core initialization.");
  assert.equal((await f.post({ type: "ready", version: "fixture-6", protocolVersion: 6, speechScope: "test-tab", readerProcessId: 123, agentOwnsReader: true, initialized: true })).status, 204);
  let confirmed = false;
  const pending = f.receiver.waitForScope("current-scope", 1000).then((value) => { confirmed = value; return value; });
  const denied = await fetch(f.receiver.endpoint, {
    method: "POST", headers: { "X-RAMBO-Token": "wrong-token" },
    body: JSON.stringify({ type: "scope-ready", scopeId: "current-scope" })
  });
  assert.equal(denied.status, 403);
  assert.equal((await f.post({ type: "scope-ready", scopeId: "old-scope" })).status, 204);
  assert.equal(confirmed, false, "A stale or unauthenticated acknowledgement must not release the current handoff.");
  assert.equal((await f.post({ type: "scope-ready", scopeId: "current-scope" })).status, 204);
  assert.equal(await pending, true);
  assert.equal(await f.receiver.waitForScope("current-scope", 20), true, "An acknowledgement received before its waiter must remain available.");
  assert.equal(await f.receiver.waitForScope("never-confirmed", 20), false);
});

test("scope stop cancels startup and handoff waiters and never accepts a late handoff", async (context) => {
  const f = await receiverFixture(context);
  if (!f) return;
  const waitingReady = f.receiver.waitForReady(1000);
  const waitingScope = f.receiver.waitForScope("pending-scope", 1000);
  assert.equal((await f.post({ type: "scope-stopped", reason: "Testing tab closed during startup" })).status, 204);
  assert.equal(await waitingReady, false);
  assert.equal(await waitingScope, false);
  assert.equal((await f.post({ type: "scope-ready", scopeId: "pending-scope" })).status, 204);
  assert.equal(await f.receiver.waitForScope("pending-scope", 20), false);
  assert.equal((await f.post({ type: "ready", version: "fixture-6", protocolVersion: 6, speechScope: "test-tab", readerProcessId: 123, agentOwnsReader: true, initialized: true })).status, 204);
  assert.equal(await f.receiver.waitForReady(20), false);
});

test("scope pause cancels pending commands without ending the session, and only a new scope resumes it", async (context) => {
  const f = await receiverFixture(context);
  if (!f) return;
  const ready = { type: "ready", version: "fixture-1.8", protocolVersion: 6, speechScope: "test-tab", readerProcessId: 123, agentOwnsReader: true, initialized: true };
  await f.post({ ...ready, capabilities: ["startup-handoff"] });
  assert.equal(f.receiver.pauseSupported, false, "Older add-ons must never be asked to pause.");
  await f.post({ ...ready, capabilities: ["startup-handoff", "scope-pause"] });
  assert.equal(f.receiver.pauseSupported, true);
  await f.post({ type: "scope-ready", scopeId: "scope-1" });
  assert.equal(f.receiver.paused, null);
  const capture = f.receiver.waitForCapture("action-1", 1000);
  const command = f.receiver.waitForCommand("action-1", 1000);
  const speech = f.receiver.waitForSpeech(1000);
  const audio = f.receiver.waitForSpeechIdle("action-1", 1, 1000);
  let notified = null;
  const unsubscribe = f.receiver.onScopePaused((reason, info) => { notified = { reason, info }; });
  const reason = "Windows Settings took the foreground.";
  assert.equal((await f.post({ type: "scope-paused", scopeId: "scope-1", reason, deadlineMs: 1_900_000_000_000 })).status, 204);
  assert.equal(await capture, false);
  assert.deepEqual(await command, { status: "blocked", reason });
  assert.equal(await speech, false);
  assert.equal(await audio, false);
  assert.equal(f.receiver.stoppedReason, null, "A pause is not a stop.");
  assert.equal(await f.receiver.waitForScopeStopped(20), false);
  assert.deepEqual(f.receiver.paused, { scopeId: "scope-1", reason, deadlineMs: 1_900_000_000_000 });
  assert.deepEqual(notified, { reason, info: { scopeId: "scope-1", reason, deadlineMs: 1_900_000_000_000 } });
  const disarm = f.receiver.waitForDisarm("disarm-1", 1000);
  await f.post({ type: "capture-disarmed", disarmId: "disarm-1" });
  assert.equal(await disarm, true, "Disarm acknowledgements keep working while paused.");

  const started = Date.now();
  const rejected = f.receiver.waitForScope("scope-2", 5000);
  await f.post({ type: "scope-paused", scopeId: "scope-2", reason: "resume rejected", detail: "The foreground tab is not the marked startup test tab." });
  assert.equal(await rejected, false);
  assert.ok(Date.now() - started < 1000, "A rejected re-handoff fails its wait immediately.");
  assert.deepEqual([f.receiver.paused.scopeId, f.receiver.paused.reason, f.receiver.paused.detail], ["scope-2", "resume rejected", "The foreground tab is not the marked startup test tab."]);
  assert.equal(f.receiver.stoppedReason, null);

  const resumed = f.receiver.waitForScope("scope-3", 1000);
  await f.post({ type: "scope-ready", scopeId: "scope-3" });
  assert.equal(await resumed, true);
  assert.equal(f.receiver.paused, null, "A scope-ready for a newer scope clears the pause.");
  notified = null;
  const liveCapture = f.receiver.waitForCapture("action-2", 1000);
  await f.post({ type: "scope-paused", scopeId: "scope-1", reason: "Late report for the replaced scope" });
  assert.equal(f.receiver.paused, null);
  assert.equal(notified, null);
  await f.post({ type: "capture-ready", actionId: "action-2" });
  assert.equal(await liveCapture, true, "A stale pause must not cancel the resumed scope.");

  await f.post({ type: "scope-stopped", reason: "The pause deadline expired; NVDA is shutting down." });
  assert.equal(f.receiver.stoppedReason, "The pause deadline expired; NVDA is shutting down.");
  await f.post({ type: "scope-paused", scopeId: "scope-3", reason: "After stop" });
  assert.equal(notified, null, "A stop stays terminal; later pause reports are ignored.");
  await f.post({ type: "scope-ready", scopeId: "scope-4" });
  assert.equal(await f.receiver.waitForScope("scope-4", 20), false);
  unsubscribe();
});

test("NVDA control writes retry a briefly locked control file", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".nvda-scope-test-"));
  const rename = fs.rename.bind(fs);
  try {
    const file = path.join(directory, "control.json");
    let attempts = 0;
    const locked = mock.method(fs, "rename", async (...args) => {
      if (++attempts <= 2) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      return rename(...args);
    });
    try { await writeControlFile(file, { runId: "retry-run", lifecycle: "paused" }); } finally { locked.mock.restore(); }
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).lifecycle, "paused");

    attempts = 0;
    const stuck = mock.method(fs, "rename", async () => { attempts++; throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }); });
    try { await assert.rejects(writeControlFile(file, { runId: "retry-run", lifecycle: "testing" }), /EBUSY/); } finally { stuck.mock.restore(); }
    assert.equal(attempts, 5, "Retries are bounded.");

    attempts = 0;
    const missing = mock.method(fs, "rename", async () => { attempts++; throw Object.assign(new Error("ENOENT: missing"), { code: "ENOENT" }); });
    try { await assert.rejects(writeControlFile(file, { runId: "retry-run" }), /ENOENT/); } finally { missing.mock.restore(); }
    assert.equal(attempts, 1, "Only lock errors are retried.");
    assert.deepEqual(await fs.readdir(directory), ["control.json"], "Temporary files are removed even when every rename fails.");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).lifecycle, "paused");
  } finally {
    assert.equal(path.dirname(directory), process.cwd());
    assert.ok(path.basename(directory).startsWith(".nvda-scope-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("NVDA capture receiver authenticates and records ready and speech events", async (context) => {
  const receiver = await createNvdaCaptureReceiver({ maxEvents: 2 });
  try {
    let denied;
    try {
      denied = await fetch(receiver.endpoint, { method: "POST", body: "{}" });
    } catch (error) {
      if (error?.cause?.code === "EACCES") {
        context.skip("This sandbox blocks loopback client connections; run npm run test:nvda-integration outside the sandbox.");
        return;
      }
      throw error;
    }
    assert.equal(denied.status, 403);

    const waiting = receiver.waitForReady(1_000);
    const readyResponse = await fetch(receiver.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-RAMBO-Token": receiver.token },
      body: JSON.stringify({ type: "ready", version: "test-version", protocolVersion: 5, speechScope: "test-tab", readerProcessId: 123, agentOwnsReader: true })
    });
    assert.equal(readyResponse.status, 204);
    assert.equal(await waiting, true);
    assert.equal(receiver.version, "test-version");
    assert.equal(receiver.protocolVersion, 5);
    assert.equal(receiver.readerProcessId, 123);
    assert.equal(receiver.agentOwnsReader, true);
    assert.equal(receiver.speechScope, "test-tab");

    const captureWaiting = receiver.waitForCapture("action-1", 1_000);
    const captureResponse = await fetch(receiver.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-RAMBO-Token": receiver.token },
      body: JSON.stringify({ type: "capture-ready", actionId: "action-1" })
    });
    assert.equal(captureResponse.status, 204);
    assert.equal(await captureWaiting, true);
    const commandWaiting = receiver.waitForCommand("action-1", 1_000);
    const commandResponse = await fetch(receiver.endpoint, {
      method: "POST", headers: { "X-RAMBO-Token": receiver.token },
      body: JSON.stringify({ type: "command-result", commandId: "action-1", kind: "say-all", status: "partial", reason: "Bounded sample" })
    });
    assert.equal(commandResponse.status, 204);
    assert.deepEqual(await commandWaiting, { commandId: "action-1", kind: "say-all", status: "partial", reason: "Bounded sample", readingCompletion: "unconfirmed", audibleComplete: false });

    const mark = receiver.mark();
    const speechResponse = await fetch(receiver.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-RAMBO-Token": receiver.token },
      body: JSON.stringify({ type: "speech", actionId: "action-1", text: "Submit button", foregroundProcessId: 42, focusProcessId: 43, inDocument: true })
    });
    assert.equal(speechResponse.status, 204);
    assert.deepEqual(receiver.since(mark).map((event) => event.text), ["Submit button"]);
    assert.equal(receiver.since(mark)[0].actionId, "action-1");
    assert.equal(receiver.since(mark)[0].foregroundProcessId, 42);
    for (const text of ["Second button", "Third button"]) {
      await fetch(receiver.endpoint, {
        method: "POST", headers: { "X-RAMBO-Token": receiver.token },
        body: JSON.stringify({ type: "speech", actionId: "action-1", text, inDocument: true })
      });
    }
    const fullBufferMark = receiver.mark();
    await fetch(receiver.endpoint, {
      method: "POST", headers: { "X-RAMBO-Token": receiver.token },
      body: JSON.stringify({ type: "speech", actionId: "action-2", text: "Close button", inDocument: true })
    });
    assert.deepEqual(receiver.since(fullBufferMark).map((event) => event.text), ["Close button"], "New events must remain readable after the bounded event buffer fills.");
    const disarm = receiver.waitForDisarm("disarm-1", 1000);
    await fetch(receiver.endpoint, { method: "POST", headers: { "X-RAMBO-Token": receiver.token }, body: JSON.stringify({ type: "capture-disarmed", disarmId: "disarm-1" }) });
    assert.equal(await disarm, true);
    const pendingCapture = receiver.waitForCapture("after-close", 1000);
    const pendingCommand = receiver.waitForCommand("after-close", 1000);
    const pendingStop = receiver.waitForScopeStopped(1000);
    let reason;
    const unsubscribe = receiver.onScopeStopped((value) => { reason = value; });
    await fetch(receiver.endpoint, { method: "POST", headers: { "X-RAMBO-Token": receiver.token }, body: JSON.stringify({ type: "scope-stopped", reason: "Test tab closed" }) });
    assert.equal(await pendingCapture, false);
    assert.equal((await pendingCommand).status, "blocked");
    assert.equal(await pendingStop, true);
    assert.equal(receiver.stoppedReason, "Test tab closed");
    assert.equal(reason, "Test tab closed");
    unsubscribe();
  } finally {
    await receiver.close();
  }
});

test("NVDA control writes explicitly scope both runners to a short-lived marked test tab", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".nvda-scope-test-"));
  try {
    const file = path.join(directory, "control.json");
    const control = { runId: "test-run", capture: { active: true, actionId: "1", processId: 42, windowHandle: "420", titleMarker: "unique-tab" } };
    const before = Date.now();
    await writeControlFile(file, control);
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(stored.speechScope, "test-tab");
    assert.ok(stored.expiresAtMs >= before + 45_000 && stored.expiresAtMs <= Date.now() + 45_000);
    assert.deepEqual(stored.capture, control.capture);
    assert.equal(control.speechScope, undefined, "The writer must not mutate runtime control state.");
    await writeControlFile(file, { ...control, capture: { active: false } });
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).capture.active, false);
  } finally {
    assert.equal(path.dirname(directory), process.cwd());
    assert.ok(path.basename(directory).startsWith(".nvda-scope-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("NVDA retains website controls named Close, Back, or Reload and removes browser setup by source metadata", () => {
  const events = [
    { text: "Previous link", inDocument: true },
    { text: "Address bar", inDocument: false },
    { text: "Page document", inDocument: true, focusIsDocument: true },
    { text: "Accessibility test start", inDocument: true, isFocusAnchor: true },
    ...["Close button", "Back button", "Reload button", "Fermer bouton"].map((text) => ({ text, inDocument: true })),
    { text: "Close button", inDocument: false }
  ];
  assert.deepEqual(selectNvdaAnnouncements(events), ["Close button", "Back button", "Reload button", "Fermer bouton"]);
  assert.deepEqual(selectNvdaAnnouncements([{ text: "Unverified legacy speech" }]), []);
});

test("NVDA capability stays unavailable until explicitly enabled", () => {
  const capability = detectNvdaCapability({ allowed: false });
  assert.equal(capability.available, false);
  assert.equal(capability.configured, false);
  assert.match(capability.reason, /NVDA_ENABLED|Windows/i);
});

test("NVDA selects the initial state even when the crawl hit its one-page limit", () => {
  const report = {
    targetUrl: "https://example.test/",
    configuration: { maxPages: 1, maxDepth: 0 },
    crawlTermination: { reason: "state_limit_reached" },
    pages: [{ url: "https://example.test/", title: "Home", error: null }]
  };
  assert.equal(selectNvdaStates(report, undefined, 1).targets[0].state, "default");
  assert.equal(selectNvdaStates(report, undefined, NaN).targets.length, 1, "An invalid optional NVDA limit must not discard the only eligible state.");
  report.pages.push(
    { url: "https://example.test/", title: "Duplicate" },
    { url: "https://example.test/failure", error: "Forbidden" },
    { url: "https://external.test/login" }
  );
  assert.equal(selectNvdaStates(report, undefined, 3).targets.length, 1);
});

test("an unavailable NVDA run on one eligible page remains honestly not executed", async () => {
  const result = await runNvdaWebsiteTest({
    report: { targetUrl: "https://example.test/", pages: [{ url: "https://example.test/" }] },
    config: { nvda: { allowed: false, maxStates: 1 } }
  });
  assert.equal(result.actualExecution, false);
  assert.equal(result.status, "unavailable");
  assert.equal(result.outcome, "not-executed");
});

test("Windows helper failures preserve the actionable error instead of pretending launch succeeded", async () => {
  const spawnProcess = (command, args, options) => {
    assert.equal(command, "powershell.exe");
    assert.ok(args.includes("-NonInteractive"));
    assert.equal(options.windowsHide, true);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.write("NVDA launch denied: Access is denied.\r\nCheck the executable path.");
      child.emit("close", 1);
    });
    return child;
  };
  const result = await runPowerShellHelper("start-nvda.ps1", [], { spawnProcess });
  assert.equal(result.ok, false);
  assert.match(result.reason, /NVDA launch denied: Access is denied/);
  assert.match(result.reason, /Check the executable path/);
});

test("Windows helper process errors resolve as failures without an unhandled error event", async () => {
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => child.emit("error", new Error("spawn powershell.exe EACCES")));
    return child;
  };
  const result = await runPowerShellHelper("start-nvda.ps1", [], { spawnProcess });
  assert.deepEqual(result, { ok: false, reason: "spawn powershell.exe EACCES" });
});

test("NVDA startup probe uses session-scoped fallback and never treats unknown status as stopped", () => {
  for (const running of [false, true]) {
    const calls = [];
    const result = checkNvdaRunning("nvda.exe", (command, args, options) => {
      calls.push(command);
      if (command === "nvda.exe") return { error: { code: "EACCES" }, status: null };
      assert.ok(args.some((arg) => arg.includes("SessionId")));
      assert.equal(options.timeout, 20_000);
      return { status: running ? 0 : 1 };
    });
    assert.equal(result, running);
    assert.deepEqual(calls, ["nvda.exe", "powershell.exe"]);
  }
  assert.throws(() => checkNvdaRunning("nvda.exe", () => ({ status: null, error: { code: "ETIMEDOUT" } })), /ETIMEDOUT.*No NVDA instance was started or stopped/);
});

test("asynchronous NVDA startup probe uses the persistent helper and returns only confirmed boolean status", async () => {
  for (const running of [false, true]) {
    const calls = [];
    const helper = { send: async (request, timeoutMs) => {
      calls.push({ request, timeoutMs });
      return { ok: true, running };
    } };
    assert.equal(await probeNvdaRunning(helper), running);
    assert.deepEqual(calls, [{ request: { op: "nvda-status" }, timeoutMs: 5000 }]);
  }
});

test("asynchronous NVDA startup probe rejects unknown or failed status instead of claiming NVDA is stopped", async () => {
  for (const reply of [undefined, null, {}, { running: false }, { ok: true }, { ok: true, running: "false" }, { ok: true, running: 0 }, { ok: false, running: false, reason: "Permission denied" }]) {
    await assert.rejects(probeNvdaRunning({ send: async () => reply }), "An unconfirmed native status must never permit reader launch.");
  }
  await assert.rejects(probeNvdaRunning({ send: async () => { throw new Error("NVDA status query timed out"); } }), /timed out/);
});
