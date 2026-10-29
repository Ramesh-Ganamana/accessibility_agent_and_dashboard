import http from "node:http";
import { randomBytes } from "node:crypto";
import { clean } from "./text.js";

export async function createNvdaCaptureReceiver({ maxEvents = 2_000 } = {}) {
  const token = randomBytes(24).toString("hex");
  const events = [];
  let ready = false;
  let receiverClosed = false;
  let initialized = false;
  let capabilities = new Set();
  let speechSettings = null;
  let speechSettingsSequence = 0;
  const updateSpeechSettings = (settings) => {
    if (settings && Number.isFinite(settings.rate) && settings.rate >= 0 && settings.rate <= 100) {
      speechSettings = { rate: settings.rate, rateBoost: typeof settings.rateBoost === "boolean" ? settings.rateBoost : null };
    }
  };
  let version = null;
  let protocolVersion = 0;
  let speechScope = null;
  let readerProcessId = null;
  let agentOwnsReader = false;
  let stoppedReason = null;
  // A pause is not terminal: the add-on stays alive and silent until the agent
  // re-establishes a new scope or the pause deadline makes it stop.
  let paused = null;
  let latestReadyScope = null;
  const pausedListeners = new Set();
  const stoppedListeners = new Set();
  const stoppedWaiters = new Set();
  const disarmed = new Set();
  const disarmWaiters = new Map();
  const scopesReady = new Set();
  const scopeWaiters = new Map();
  const latestSpoken = new Map();
  const speechIdle = new Map();
  const audioWaiters = new Set();
  const audioIsIdle = (actionId, minimumSequence) => {
    const latest = Math.max(minimumSequence, latestSpoken.get(actionId) || 0);
    return latest > 0 && (speechIdle.get(actionId) || 0) >= latest;
  };
  let sequence = 0;
  const waiters = new Set();
  const speechWaiters = new Set();
  const captureReady = new Set();
  const captureWaiters = new Map();
  const commandResults = new Map();
  const commandWaiters = new Map();
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.headers["x-rambo-token"] !== token) {
      response.writeHead(403).end();
      return;
    }
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length <= 64_000) chunks.push(chunk);
    });
    request.on("end", () => {
      if (length > 64_000) { response.writeHead(413).end(); return; }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (payload.type === "ready") {
          // Protocol 6 reports completion of NVDA core startup, not just add-on
          // construction. Never navigate on an early or malformed ready event.
          const protocol = Number(payload.protocolVersion) || 0;
          initialized = payload.initialized === true;
          capabilities = new Set(Array.isArray(payload.capabilities) ? payload.capabilities.filter((entry) => typeof entry === "string") : []);
          ready = protocol < 6 || initialized;
          version = clean(payload.version, 80) || null;
          protocolVersion = Number(payload.protocolVersion) || 0;
          speechScope = payload.speechScope === "test-tab" ? "test-tab" : null;
          readerProcessId = Number.isInteger(payload.readerProcessId) && payload.readerProcessId > 0 ? payload.readerProcessId : null;
          agentOwnsReader = payload.agentOwnsReader === true;
          if (ready) {
            for (const resolve of waiters) resolve(true);
            waiters.clear();
          }
        } else if (payload.type === "scope-stopped") {
          stoppedReason ||= clean(payload.reason, 500) || "The NVDA test tab is no longer active; NVDA stopped.";
          for (const resolve of waiters) resolve(false);
          waiters.clear();
          for (const waiter of [...audioWaiters]) waiter.done(false);
          for (const resolve of [...speechWaiters]) resolve(false);
          speechWaiters.clear();
          for (const resolve of stoppedWaiters) resolve(true);
          stoppedWaiters.clear();
          for (const resolve of captureWaiters.values()) resolve(false);
          captureWaiters.clear();
          for (const resolve of scopeWaiters.values()) resolve(false);
          scopeWaiters.clear();
          for (const resolve of commandWaiters.values()) resolve({ status: "blocked", reason: stoppedReason });
          commandWaiters.clear();
          for (const resolve of disarmWaiters.values()) resolve(false);
          disarmWaiters.clear();
          for (const listener of stoppedListeners) { try { listener(stoppedReason); } catch {} }
        } else if (payload.type === "scope-paused") {
          const scopeId = clean(payload.scopeId, 100) || null;
          // A late pause for a scope that a newer handoff already replaced must not
          // cancel commands in the resumed scope. Stop always stays terminal.
          if (!stoppedReason && !(scopeId && scopesReady.has(scopeId) && scopeId !== latestReadyScope)) {
            const reason = clean(payload.reason, 500) || "The NVDA test tab is not in front; NVDA paused.";
            const deadlineMs = Number.isFinite(Number(payload.deadlineMs)) && Number(payload.deadlineMs) > 0 ? Number(payload.deadlineMs) : null;
            const detail = clean(payload.detail, 500);
            paused = { scopeId, reason, deadlineMs, ...(detail ? { detail } : {}) };
            for (const waiter of [...audioWaiters]) waiter.done(false);
            for (const resolve of [...speechWaiters]) resolve(false);
            speechWaiters.clear();
            for (const resolve of captureWaiters.values()) resolve(false);
            captureWaiters.clear();
            for (const resolve of commandWaiters.values()) resolve({ status: "blocked", reason });
            commandWaiters.clear();
            // A rejected re-handoff names the scope it refused; fail that wait now.
            if (scopeId && !scopesReady.has(scopeId)) { scopeWaiters.get(scopeId)?.(false); scopeWaiters.delete(scopeId); }
            for (const listener of pausedListeners) { try { listener(reason, { ...paused }); } catch {} }
          }
        } else if (payload.type === "scope-ready") {
          const scopeId = clean(payload.scopeId, 100);
          if (ready && initialized && scopeId && !stoppedReason) {
            updateSpeechSettings(payload.speechSettings);
            latestReadyScope = scopeId;
            if (paused && paused.scopeId !== scopeId) paused = null;
            scopesReady.add(scopeId);
            if (scopesReady.size > maxEvents) scopesReady.delete(scopesReady.values().next().value);
            scopeWaiters.get(scopeId)?.(true);
            scopeWaiters.delete(scopeId);
          }
        } else if (payload.type === "capture-disarmed") {
          const disarmId = clean(payload.disarmId, 100);
          if (disarmId) {
            disarmed.add(disarmId);
            if (disarmed.size > maxEvents) disarmed.delete(disarmed.values().next().value);
            disarmWaiters.get(disarmId)?.(true);
            disarmWaiters.delete(disarmId);
          }
        } else if (payload.type === "capture-ready") {
          const actionId = clean(payload.actionId, 100);
          if (actionId) {
            captureReady.add(actionId);
            const resolve = captureWaiters.get(actionId);
            if (resolve) resolve(true);
            captureWaiters.delete(actionId);
          }
        } else if (payload.type === "command-result") {
          const commandId = clean(payload.commandId, 100);
          if (commandId) {
            const result = { commandId, status: clean(payload.status, 40), reason: clean(payload.reason, 500), kind: clean(payload.kind, 40) };
            if (result.kind === "say-all") {
              result.readingCompletion = ["completed", "timed-out", "interrupted", "unconfirmed"].includes(payload.readingCompletion) ? payload.readingCompletion : "unconfirmed";
              result.audibleComplete = payload.audibleComplete === true;
            }
            commandResults.set(commandId, result);
            if (commandResults.size > maxEvents) commandResults.delete(commandResults.keys().next().value);
            commandWaiters.get(commandId)?.(result);
            commandWaiters.delete(commandId);
          }
        } else if (payload.type === "speech-idle") {
          const actionId = clean(payload.actionId, 100);
          const speechSequence = payload.speechSequence;
          if (payload.audibleComplete === true && actionId && Number.isInteger(speechSequence) && speechSequence > 0 && !stoppedReason) {
            if (speechSequence >= speechSettingsSequence) {
              speechSettingsSequence = speechSequence;
              updateSpeechSettings(payload.speechSettings);
            }
            speechIdle.set(actionId, Math.max(speechSequence, speechIdle.get(actionId) || 0));
            if (speechIdle.size > maxEvents) speechIdle.delete(speechIdle.keys().next().value);
            for (const waiter of [...audioWaiters]) {
              if (waiter.actionId === actionId && audioIsIdle(actionId, waiter.minimumSequence)) waiter.done(true);
            }
          }
        } else if (payload.type === "speech") {
          const text = clean(payload.text, 1_000);
          const actionId = clean(payload.actionId, 100);
          if (text && actionId) events.push({
            sequence: ++sequence,
            at: new Date().toISOString(),
            text,
            actionId,
            speechSequence: Number.isInteger(payload.speechSequence) && payload.speechSequence > 0 ? payload.speechSequence : null,
            foregroundProcessId: Number(payload.foregroundProcessId) || null,
            focusProcessId: Number(payload.focusProcessId) || null,
            inDocument: payload.inDocument === true,
            focusIsDocument: payload.focusIsDocument === true,
            isFocusAnchor: payload.isFocusAnchor === true
          });
          if (text && actionId && Number.isInteger(payload.speechSequence) && payload.speechSequence > 0) {
            latestSpoken.set(actionId, Math.max(payload.speechSequence, latestSpoken.get(actionId) || 0));
            if (latestSpoken.size > maxEvents) latestSpoken.delete(latestSpoken.keys().next().value);
          }
          if (events.length > maxEvents) events.shift();
          for (const resolve of speechWaiters) resolve(true);
          speechWaiters.clear();
        }
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    token,
    endpoint: `http://127.0.0.1:${address.port}`,
    get version() { return version; },
    get protocolVersion() { return protocolVersion; },
    get initialized() { return initialized; },
    get audioCompletionSupported() { return capabilities.has("audible-completion"); },
    get readingCompletionSupported() { return capabilities.has("reading-completion"); },
    get pauseSupported() { return capabilities.has("scope-pause"); },
    get paused() { return paused ? { ...paused } : null; },
    get speechSettings() { return speechSettings; },
    get speechScope() { return speechScope; },
    get readerProcessId() { return readerProcessId; },
    get agentOwnsReader() { return agentOwnsReader; },
    get stoppedReason() { return stoppedReason; },
    onScopeStopped(listener) { stoppedListeners.add(listener); return () => stoppedListeners.delete(listener); },
    onScopePaused(listener) { pausedListeners.add(listener); return () => pausedListeners.delete(listener); },
    waitForScope(scopeId, timeoutMs) {
      if (stoppedReason) return Promise.resolve(false);
      if (scopesReady.has(scopeId)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (value) => { clearTimeout(timeout); resolve(value); };
        const timeout = setTimeout(() => { scopeWaiters.delete(scopeId); resolve(false); }, timeoutMs);
        scopeWaiters.set(scopeId, done);
      });
    },
    waitForScopeStopped(timeoutMs) {
      if (stoppedReason) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (value) => { clearTimeout(timeout); resolve(value); };
        const timeout = setTimeout(() => { stoppedWaiters.delete(done); resolve(false); }, timeoutMs);
        stoppedWaiters.add(done);
      });
    },
    waitForDisarm(disarmId, timeoutMs) {
      if (stoppedReason) return Promise.resolve(false);
      if (disarmed.has(disarmId)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (value) => { clearTimeout(timeout); resolve(value); };
        const timeout = setTimeout(() => { disarmWaiters.delete(disarmId); resolve(false); }, timeoutMs);
        disarmWaiters.set(disarmId, done);
      });
    },
    mark: () => sequence,
    since: (mark) => events.filter((event) => event.sequence > mark),
    // Resolves on the next transcript (or the timeout) instead of polling.
    waitForSpeech(timeoutMs) {
      return new Promise((resolve) => {
        const done = (value) => { clearTimeout(timeout); speechWaiters.delete(done); resolve(value); };
        const timeout = setTimeout(() => done(false), Math.max(1, timeoutMs));
        speechWaiters.add(done);
      });
    },
    waitForSpeechIdle(actionId, minimumSequence, timeoutMs) {
      if (receiverClosed || stoppedReason || !Number.isInteger(minimumSequence) || minimumSequence <= 0) return Promise.resolve(false);
      if (audioIsIdle(actionId, minimumSequence)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const waiter = { actionId, minimumSequence, done: null };
        waiter.done = (value) => { clearTimeout(timeout); audioWaiters.delete(waiter); resolve(value); };
        const timeout = setTimeout(() => waiter.done(false), Math.max(1, timeoutMs));
        audioWaiters.add(waiter);
      });
    },
    waitForReady(timeoutMs) {
      if (stoppedReason) return Promise.resolve(false);
      if (ready) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timeout = setTimeout(() => { waiters.delete(done); resolve(false); }, timeoutMs);
        const done = (value) => { clearTimeout(timeout); resolve(value); };
        waiters.add(done);
      });
    },
    waitForCapture(actionId, timeoutMs) {
      if (stoppedReason) return Promise.resolve(false);
      if (captureReady.has(actionId)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          captureWaiters.delete(actionId);
          resolve(false);
        }, timeoutMs);
        captureWaiters.set(actionId, (value) => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
    },
    waitForCommand(commandId, timeoutMs) {
      if (stoppedReason) return Promise.resolve({ status: "blocked", reason: stoppedReason });
      if (commandResults.has(commandId)) return Promise.resolve(commandResults.get(commandId));
      return new Promise((resolve) => {
        const timeout = setTimeout(() => { commandWaiters.delete(commandId); resolve(null); }, timeoutMs);
        commandWaiters.set(commandId, (value) => { clearTimeout(timeout); resolve(value); });
      });
    },
    close: () => {
      receiverClosed = true;
      for (const waiter of [...audioWaiters]) waiter.done(false);
      for (const resolve of [...speechWaiters]) resolve(false);
      speechWaiters.clear();
      for (const resolve of stoppedWaiters) resolve(false);
      stoppedWaiters.clear();
      stoppedListeners.clear();
      pausedListeners.clear();
      for (const resolve of scopeWaiters.values()) resolve(false);
      scopeWaiters.clear();
      for (const resolve of disarmWaiters.values()) resolve(false);
      disarmWaiters.clear();
      for (const resolve of waiters) resolve(false);
      waiters.clear();
      for (const resolve of captureWaiters.values()) resolve(false);
      captureWaiters.clear();
      for (const resolve of commandWaiters.values()) resolve(null);
      commandWaiters.clear();
      return new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  };
}
