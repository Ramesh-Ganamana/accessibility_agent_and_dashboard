import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { buildNvdaLivePlan, createLiveNvdaSession, liveStateIdentity } from "../src/assistive-technology/nvda-live.js";
import { getConfig } from "../src/config.js";

async function fixture(context, options = {}) {
  const outputDir = await fs.mkdtemp(path.join(process.cwd(), ".nvda-live-test-"));
  const events = [];
  const commands = [];
  const screenshots = [];
  let sequence = 0;
  let closes = 0;
  let tabs = 0;
  let cleanup = false;
  let starts = 0;
  let writes = 0;
  let startupArgs;
  let pausedListener = null;
  const controls = [];
  const emitted = [];
  const scopeWaits = [];
  const structure = { url: "https://fixture.test/", dialogs: [], tabs: [], expanded: [], frames: [], headings: 2, tables: 1 };
  const browser = new EventEmitter();
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ browser: () => browser }),
    url: () => "about:blank", setContent: async () => {}, bringToFront: async () => {},
    evaluate: async (fn, arg) => { if (arg === undefined && String(fn).includes("delete window.__ramboNvdaLive")) cleanup = true; },
    screenshot: async () => { screenshots.push(true); return Buffer.from(options.sameScreenshot ? "same fixture image" : `fixture image ${screenshots.length}`); }
  });
  const capture = {
    runId: "fixture", control: { capture: { active: false } }, close: async () => { closes++; },
    receiver: {
      version: "fixture-version", waitForCapture: async () => true,
      waitForScope: async (scopeId) => {
        scopeWaits.push(scopeId);
        assert.equal(capture.control.lifecycle, "testing", "The reader must enter strict testing scope before the handoff is acknowledged.");
        assert.equal(capture.control.scopeId, scopeId);
        assert.equal(capture.control.capture?.active, false, "Startup handoff must never arm speech capture.");
        return true;
      },
      mark: () => sequence, since: (mark) => events.filter((event) => event.sequence > mark),
      waitForCommand: async (_id) => ({ status: capture.control.capture.command.kind === "say-all" ? "partial" : "executed" }),
      // Only add-ons that advertise "scope-pause" may be paused instead of stopped.
      ...(options.pauseSupported !== undefined ? {
        pauseSupported: options.pauseSupported,
        onScopePaused: (listener) => { pausedListener = listener; return () => { pausedListener = null; }; }
      } : {})
    },
    write: async () => {
      writes++;
      controls.push(structuredClone(capture.control));
      const command = capture.control.capture?.command;
      if (command) { commands.push(command); events.push({ sequence: ++sequence, actionId: command.id, text: "Fixture heading", inDocument: true }); }
    }
  };
  const dependencies = {
    start: async (args) => { starts++; startupArgs = args; return capture; }, inspect: async () => structuredClone(structure),
    scopeIntervalMs: 10,
    trackFocus: async () => null,
    focusWindow: async () => ({ ok: true, processId: 42, windowHandle: "24" }),
    prepareFocus: async () => ({ ok: true }), focusPreparation: async () => {}, anchor: async () => true, nativeAnchor: async () => ({ ok: true }), nativeFocus: async () => ({ ok: true, inDocument: true }),
    tabActive: async () => true,
    speechWait: async () => {}, describe: async () => ({ tag: "a", documentFocused: true }),
    sendTab: async () => {
      tabs++;
      events.push({ sequence: ++sequence, actionId: capture.control.capture.actionId, text: "Account link", inDocument: true });
      options.afterTab?.(structure, tabs);
      return options.tabResult || { ok: true };
    }, ...options.dependencies
  };
  if (options.useDefaultFocusTracking) {
    delete dependencies.trackFocus;
    delete dependencies.tabActive;
  }
  const session = await createLiveNvdaSession({ config: { nvda: { tests: ["focus"], tabStops: 2, ...options.nvda } }, outputDir, emit: (event) => emitted.push(event), dependencies });
  context.after(async () => {
    await session.close();
    assert.equal(path.dirname(outputDir), process.cwd());
    assert.match(path.basename(outputDir), /^\.nvda-live-test-/);
    await fs.rm(outputDir, { recursive: true, force: true });
  });
  return {
    session, page, browser, capture, commands, screenshots, structure, controls, emitted, scopeWaits,
    notifyPaused: (...args) => pausedListener?.(...args),
    get starts() { return starts; }, get startupArgs() { return startupArgs; }, get writes() { return writes; }, get tabs() { return tabs; }, get closes() { return closes; }, get cleaned() { return cleanup; }
  };
}

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

test("required fields without required speech are retained as review observations", async (context) => {
  const f = await fixture(context, { dependencies: {
    describe: async () => ({ tag: "input", name: "Email", documentFocused: true,
      requiredField: { expectation: "required", language: "en", sources: ["Associated asterisk", "Asterisk explained as required"] } }),
    speechWait: async () => ({ audibleComplete: true })
  } });
  await f.session.preparePage(f.page);
  const result = await f.session.testState(f.page, { id: "required-review" });
  assert.equal(result.checks.requiredFields.status, "needs-review");
  assert.equal(result.checks.requiredFields.commands, 2);
  assert.equal(result.actions[0].requiredFieldCheck.status, "needs-review");
  assert.equal(result.actions[0].outcome, "needs-review");
  assert.ok(result.actions[0].evidence, "Review observations retain screenshot evidence.");
  assert.deepEqual(result.actions[0].announcements, ["Account link"], "Never manufacture required speech.");
  assert.equal(f.session.finish().outcome, "needs-review");
});

test("reader starts only after the testing page is prepared", async (context) => {
  const f = await fixture(context);
  assert.equal(f.starts, 0);
  assert.equal(await f.session.preparePage(f.page), true);
  assert.equal(f.starts, 1);
  assert.deepEqual(f.startupArgs.browserScope, { processId: 42, windowHandle: "24" });
  assert.equal(f.startupArgs.startupHandoff, true);
  assert.equal(f.writes, 1, "The one-time startup handoff must be acknowledged before the application loads.");
  const timing = f.session.finish().startupTiming;
  for (const name of ["browserFocusMs", "readerReadyMs", "nativeFocusMs", "totalMs"]) {
    assert.ok(Number.isFinite(timing[name]) && timing[name] >= 0, `${name} must record a numeric startup duration.`);
  }
});

test("native tab focus tracking is attached before NVDA starts and detached once when the session closes", async (context) => {
  let f;
  let attachments = 0;
  let detachments = 0;
  f = await fixture(context, { dependencies: {
    trackFocus: async (page) => {
      assert.equal(page, f.page);
      assert.equal(f.starts, 0, "Real focus tracking must be established before NVDA is launched.");
      attachments++;
      return { detach: async () => { detachments++; } };
    }
  } });
  assert.equal(await f.session.preparePage(f.page), true);
  assert.equal(f.starts, 1);
  assert.equal(attachments, 1);
  assert.equal(detachments, 0, "The tracking session must remain attached throughout NVDA testing.");
  assert.equal(await f.session.preparePage(f.page), true);
  assert.equal(attachments, 1);
  await f.session.close();
  await f.session.close();
  assert.equal(detachments, 1);
  assert.equal(f.closes, 1);
});

test("failure to disable emulated browser focus prevents NVDA startup", async (context) => {
  const f = await fixture(context, { dependencies: {
    trackFocus: async () => { throw new Error("Chrome real tab focus tracking could not be established"); }
  } });
  assert.equal(await f.session.preparePage(f.page), false);
  assert.equal(f.starts, 0);
  assert.equal(f.writes, 0);
  assert.equal(f.tabs, 0);
  assert.equal(f.session.finish().actualExecution, false);
  assert.match(f.session.finish().reason, /real tab focus tracking/);
});

test("a failed startup handoff detaches browser focus tracking", async (context) => {
  let detachments = 0;
  const f = await fixture(context, { dependencies: {
    trackFocus: async () => ({ detach: async () => { detachments++; } })
  } });
  f.capture.receiver.waitForScope = async () => false;
  assert.equal(await f.session.preparePage(f.page), false);
  await f.session.close();
  assert.equal(f.closes, 1);
  assert.equal(detachments, 1);
});

test("real focus checks clear Chrome's renderer focus override before every observation", async (context) => {
  const f = await fixture(context, { useDefaultFocusTracking: true });
  let active = true;
  let focusEmulated = true;
  let backgroundObservations = 0;
  let attachments = 0;
  let detachments = 0;
  const operations = [];
  const tracking = {
    send: async (method, params) => {
      assert.equal(method, "Emulation.setFocusEmulationEnabled");
      assert.deepEqual(params, { enabled: false });
      focusEmulated = false;
      operations.push("disable-focus-emulation");
    },
    detach: async () => { detachments++; }
  };
  f.page.context = () => ({
    browser: () => f.browser,
    newCDPSession: async (page) => {
      assert.equal(page, f.page);
      attachments++;
      return tracking;
    }
  });
  f.page.evaluate = async (fn) => {
    assert.match(String(fn), /document\.visibilityState/);
    assert.equal(operations.at(-1), "disable-focus-emulation", "Each scope observation must clear the renderer override immediately beforehand.");
    operations.push("observe-real-tab-focus");
    const result = focusEmulated || active;
    if (!active) backgroundObservations++;
    // A renderer swap can reapply Playwright's true override between checks.
    focusEmulated = true;
    return result;
  };
  assert.equal(await f.session.preparePage(f.page), true);
  assert.equal(attachments, 1);
  active = false;
  const deadline = Date.now() + 2000;
  while (!f.closes && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.closes, 1, "A background tab must stop NVDA even when Chrome reapplies the automation focus override.");
  assert.ok(backgroundObservations >= 2);
  assert.match(f.session.finish().stoppedReason, /lost focus/);
  assert.equal(detachments, 1);
  assert.equal(f.tabs, 0);
});

test("canceling while preparation content is pending prevents subsequent foreground activation", async (context) => {
  let finishContent;
  let nativeFocuses = 0;
  let frontActivations = 0;
  const f = await fixture(context, { dependencies: {
    focusWindow: async () => { nativeFocuses++; return { ok: true, processId: 42, windowHandle: "24" }; }
  } });
  f.page.setContent = () => new Promise((resolve) => { finishContent = resolve; });
  f.page.bringToFront = async () => { frontActivations++; };
  const preparing = f.session.preparePage(f.page);
  while (!finishContent) await new Promise((resolve) => setImmediate(resolve));
  await f.session.close();
  finishContent();
  assert.equal(await preparing, false);
  assert.equal(frontActivations, 0);
  assert.equal(nativeFocuses, 0);
  assert.equal(f.starts, 0);
});

test("NVDA starts after browser focus and prepares native focus only after reader readiness", async (context) => {
  const order = [];
  let completeStartup;
  let f;
  f = await fixture(context, { dependencies: {
    focusWindow: async () => { order.push("browser-focus"); return { ok: true, processId: 42, windowHandle: "24" }; },
    focusPreparation: async () => { order.push("blank-document-focus"); },
    tabActive: async () => true,
    start: (args) => {
      order.push("reader-start");
      assert.deepEqual(args.browserScope, { processId: 42, windowHandle: "24" });
      assert.equal(args.startupHandoff, true);
      return new Promise((resolve) => { completeStartup = () => { order.push("reader-ready"); resolve(f.capture); }; });
    },
    prepareFocus: async (title, processId) => {
      order.push("native-document-focus");
      assert.match(title, /^RAMBO NVDA prepare /);
      assert.equal(processId, 42);
      return { ok: true };
    }
  } });
  const preparing = f.session.preparePage(f.page);
  while (!completeStartup) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["browser-focus", "blank-document-focus", "reader-start"]);
  assert.equal(f.writes, 0);
  completeStartup();
  assert.equal(await preparing, true);
  assert.deepEqual(order, ["browser-focus", "blank-document-focus", "reader-start", "reader-ready", "browser-focus", "blank-document-focus", "native-document-focus"]);
  assert.equal(f.writes, 1);
  await f.session.testState(f.page, { id: "after-readiness" });
  assert.ok(f.writes > 0, "Actual test commands must still arm and disarm capture.");
  assert.equal(f.capture.control.capture.active, false, "Command-final capture disarming remains required.");
});

test("unsafe foreground or inactive test tab prevents NVDA startup", async (context) => {
  for (const dependencies of [
    { focusWindow: async () => ({ ok: false, reason: "Wrong foreground process" }) },
    { tabActive: async () => false }
  ]) {
    const f = await fixture(context, { dependencies });
    assert.equal(await f.session.preparePage(f.page), false);
    assert.equal(f.starts, 0, "An unverified or inactive test browser must not launch the reader.");
    assert.equal(f.writes, 0);
    assert.equal(f.session.finish().actualExecution, false);
    assert.match(f.session.finish().reason, /foreground|lost focus/);
  }
});

test("temporary startup focus loss is allowed until the one-time verified Chrome handoff", async (context) => {
  let active = true;
  let signal;
  let completeStartup;
  let windowFocuses = 0;
  let nativePreparations = 0;
  const f = await fixture(context, { dependencies: {
    tabActive: async () => active,
    focusWindow: async () => {
      if (++windowFocuses === 2) active = true;
      return { ok: true, processId: 42, windowHandle: "24" };
    },
    start: (args) => { signal = args.signal; return new Promise((resolve) => { completeStartup = resolve; }); },
    prepareFocus: async () => { nativePreparations++; return { ok: true }; }
  } });
  const preparing = f.session.preparePage(f.page);
  while (!completeStartup) await new Promise((resolve) => setImmediate(resolve));
  active = false;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(signal.aborted, false, "NVDA's cold startup can briefly activate system UI before the handoff.");
  assert.equal(nativePreparations, 0);
  assert.equal(f.writes, 0, "No testing scope or speech may be armed while cold startup is pending.");
  completeStartup(f.capture);
  assert.equal(await preparing, true);
  assert.equal(windowFocuses, 2);
  assert.equal(nativePreparations, 1);
  assert.equal(f.writes, 1);
  active = false;
  const deadline = Date.now() + 2000;
  while (!f.closes && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.closes, 1);
  assert.match(f.session.finish().stoppedReason, /lost focus/);
  assert.equal(await f.session.preparePage(f.page), false, "After handoff, losing the tab must not trigger focus reacquisition or restart.");
  assert.equal(windowFocuses, 2);
});

test("startup handoff rejects a different Chrome process or window", async (context) => {
  for (const changedWindow of [{ processId: 43, windowHandle: "24" }, { processId: 42, windowHandle: "25" }]) {
    let windowFocuses = 0;
    let nativePreparations = 0;
    const f = await fixture(context, { dependencies: {
      focusWindow: async () => ({ ok: true, ...(++windowFocuses === 1 ? { processId: 42, windowHandle: "24" } : changedWindow) }),
      prepareFocus: async () => { nativePreparations++; return { ok: true }; }
    } });
    assert.equal(await f.session.preparePage(f.page), false);
    assert.equal(nativePreparations, 0);
    assert.equal(f.writes, 0);
    assert.equal(f.closes, 1);
    assert.equal(f.session.finish().actualExecution, false);
  }
});

test("application preparation waits for the current strict-scope acknowledgement", async (context) => {
  const f = await fixture(context);
  let acknowledge;
  let acknowledgedId;
  f.capture.receiver.waitForScope = (scopeId, timeoutMs) => {
    acknowledgedId = scopeId;
    assert.equal(timeoutMs, 2500);
    assert.equal(f.capture.control.lifecycle, "testing");
    assert.equal(f.capture.control.scopeId, scopeId);
    return new Promise((resolve) => { acknowledge = resolve; });
  };
  let prepared = false;
  const preparing = f.session.preparePage(f.page).then((value) => { prepared = value; return value; });
  while (!acknowledge) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared, false);
  assert.equal(f.tabs, 0);
  assert.equal(typeof acknowledgedId, "string");
  assert.ok(acknowledgedId.length > 0);
  acknowledge(true);
  assert.equal(await preparing, true);
});

test("a missing strict-scope acknowledgement closes the reader and blocks application preparation", async (context) => {
  const f = await fixture(context);
  f.capture.receiver.waitForScope = async () => false;
  assert.equal(await f.session.preparePage(f.page), false);
  assert.equal(f.closes, 1);
  assert.equal(f.tabs, 0);
  assert.equal(f.session.finish().actualExecution, false);
});

test("a reader already stopped when startup resolves never prepares native focus or reports ready", async (context) => {
  let nativePreparations = 0;
  const f = await fixture(context, { dependencies: {
    prepareFocus: async () => { nativePreparations++; return { ok: true }; }
  } });
  f.capture.stoppedReason = "The testing tab lost its native scope during reader startup.";
  assert.equal(await f.session.preparePage(f.page), false);
  assert.equal(nativePreparations, 0, "A stopped reader must not re-enter the desktop through native focus preparation.");
  assert.equal(f.closes, 1);
  assert.equal(f.writes, 0);
  assert.equal(f.session.finish().actualExecution, false);
  assert.match(f.session.finish().reason, /lost its native scope/);
});

test("scope-stop notifications during subscription or native preparation cancel startup", async (context) => {
  for (const stopAt of ["subscription", "native-preparation"]) {
    const reason = `The testing tab lost native scope at ${stopAt}.`;
    let notifyStopped;
    let nativePreparations = 0;
    const f = await fixture(context, { dependencies: {
      prepareFocus: async () => {
        nativePreparations++;
        assert.equal(typeof notifyStopped, "function", "Scope-stop notifications must be subscribed before native focus preparation.");
        notifyStopped(reason);
        return { ok: true };
      }
    } });
    f.capture.receiver.onScopeStopped = (listener) => {
      notifyStopped = listener;
      if (stopAt === "subscription") listener(reason);
      return () => {};
    };
    assert.equal(await f.session.preparePage(f.page), false);
    assert.equal(nativePreparations, stopAt === "subscription" ? 0 : 1);
    assert.equal(f.closes, 1);
    assert.equal(f.writes, 0);
    assert.equal(f.session.finish().actualExecution, false);
    assert.equal(f.session.finish().stoppedReason, reason);
  }
});

test("closing or crashing the tab and disconnecting Chrome during startup abort launch", async (context) => {
  for (const event of ["close", "crash", "disconnected"]) {
    let completeStartup;
    let signal;
    let windowFocuses = 0;
    const f = await fixture(context, { dependencies: {
      start: (args) => { signal = args.signal; return new Promise((resolve) => { completeStartup = resolve; }); },
      focusWindow: async () => { windowFocuses++; return { ok: true, processId: 42, windowHandle: "24" }; }
    } });
    const preparing = f.session.preparePage(f.page);
    while (!completeStartup) await new Promise((resolve) => setImmediate(resolve));
    (event === "disconnected" ? f.browser : f.page).emit(event);
    assert.equal(signal.aborted, true);
    completeStartup(f.capture);
    assert.equal(await preparing, false);
    await f.session.close();
    assert.equal(f.closes, 1);
    assert.equal(windowFocuses, 1, "A canceled startup must never reacquire desktop focus afterward.");
    assert.equal(f.writes, 0);
  }
});

test("closing or crashing the testing tab and disconnecting Chrome stop NVDA once", async (context) => {
  for (const event of ["close", "crash", "disconnected"]) {
    const f = await fixture(context);
    await f.session.preparePage(f.page);
    (event === "disconnected" ? f.browser : f.page).emit(event);
    await f.session.close();
    assert.equal(f.closes, 1);
    assert.match(f.session.finish().stoppedReason, /stopped/);
    const next = await f.session.testState(f.page, { id: "after-stop" });
    assert.equal(next.status, "blocked");
    assert.equal(f.tabs, 0);
  }
});

test("leaving the test tab stops the reader between states and does not restart it", async (context) => {
  let active = true;
  const f = await fixture(context, { dependencies: { tabActive: async () => active } });
  await f.session.preparePage(f.page);
  active = false;
  const deadline = Date.now() + 2000;
  while (!f.closes && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.closes, 1);
  assert.match(f.session.finish().stoppedReason, /lost focus/);
  active = true;
  assert.equal(await f.session.preparePage(f.page), false);
  assert.equal(f.starts, 1);
});

test("repeated errors or hung test-tab checks stop the reader instead of retaining unverified scope", async (context) => {
  for (const failure of ["error", "hang"]) {
    let monitoring = false;
    let failedChecks = 0;
    const f = await fixture(context, { dependencies: {
      scopeIntervalMs: 10, scopeTimeoutMs: 20,
      tabActive: async () => {
        if (!monitoring) return true;
        failedChecks++;
        if (failure === "error") throw new Error("Execution context was destroyed");
        return new Promise(() => {});
      }
    } });
    assert.equal(await f.session.preparePage(f.page), true);
    monitoring = true;
    const deadline = Date.now() + 2000;
    while (!f.closes && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.closes, 1, `${failure} checks must stop the reader within a bounded interval.`);
    assert.ok(failedChecks >= 3, "Brief navigation-context failures are allowed before shutdown.");
    assert.match(f.session.finish().stoppedReason, /could no longer be verified/);
    assert.equal(f.starts, 1);
    assert.equal(f.tabs, 0);
    const result = await f.session.testState(f.page, { id: `after-${failure}` });
    assert.equal(result.status, "blocked");
    assert.equal(f.tabs, 0, "No keyboard commands may run after scope verification fails.");
  }
});

test("one transient navigation-context failure recovers without stopping the reader", async (context) => {
  let monitoring = false;
  let failedChecks = 0;
  let recoveredChecks = 0;
  const f = await fixture(context, { dependencies: {
    scopeIntervalMs: 10, scopeTimeoutMs: 20,
    tabActive: async () => {
      if (!monitoring) return true;
      if (!failedChecks) {
        failedChecks++;
        throw new Error("Execution context was destroyed during navigation");
      }
      recoveredChecks++;
      return true;
    }
  } });
  assert.equal(await f.session.preparePage(f.page), true);
  monitoring = true;
  const deadline = Date.now() + 2000;
  while (recoveredChecks < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(failedChecks, 1);
  assert.ok(recoveredChecks >= 4, "The watchdog must continue checking after a temporary navigation failure.");
  assert.equal(f.closes, 0);
  assert.equal(f.session.finish().stoppedReason, null);
  const result = await f.session.testState(f.page, { id: "after-navigation-recovery" });
  assert.equal(result.status, "executed");
  assert.equal(f.tabs, 2);
});

test("closing the tab during a command prevents every subsequent command", async (context) => {
  let f;
  f = await fixture(context, { dependencies: { sendTab: async () => { f.page.emit("close"); return { ok: true }; } } });
  await f.session.preparePage(f.page);
  const result = await f.session.testState(f.page, { id: "close-during-tab" });
  await f.session.close();
  assert.equal(result.actions.length, 1);
  assert.match(result.error, /closed/);
  assert.equal(f.closes, 1);
});

test("failed capture disarming stops the reader before temporary page cleanup", async (context) => {
  const f = await fixture(context);
  await f.session.preparePage(f.page);
  const write = f.capture.write;
  f.capture.write = async () => {
    if (f.tabs && !f.capture.control.capture.active) throw new Error("Disarm acknowledgement failed");
    return write();
  };
  const result = await f.session.testState(f.page, { id: "disarm-failure" });
  assert.match(result.error, /Disarm acknowledgement failed/);
  assert.equal(f.closes, 1);
  assert.match(f.session.finish().stoppedReason, /disarmed safely/);
  assert.equal(f.tabs, 1);
  assert.equal(f.cleaned, true);
});

test("live NVDA state identity ignores rotating text but catches routes and interactive structural state", () => {
  const state = { url: "https://fixture.test/", headings: ["Banner A"], dialogs: [], expanded: [] };
  assert.equal(liveStateIdentity(state), liveStateIdentity({ ...state, headings: ["Banner B"], text: "Price changed" }));
  for (const change of [{ url: "https://fixture.test/orders" }, { dialogs: ["modal"] }, { expanded: ["menu"] }, { tabs: ["new-tab"] }]) {
    assert.notEqual(liveStateIdentity(state), liveStateIdentity({ ...state, ...change }));
  }
});

test("live test plan is bounded and never contains forms, submission, or printable shortcut keys", () => {
  const plan = buildNvdaLivePlan({ tabStops: 999, headingStops: 999, tableStops: 999, readingTimeoutMs: 999999 }, { headings: 1, tables: 1 });
  assert.equal(plan.length, 51);
  assert.equal(plan[0].maxDurationMs, 999999);
  assert.equal(buildNvdaLivePlan()[0].maxDurationMs, 300000);
  assert.equal(buildNvdaLivePlan({ readingTimeoutMs: 9999999 })[0].maxDurationMs, 1800000);
  assert.ok(plan.every((command) => ["focus", "reading", "headings", "tables"].includes(command.kind)));
  assert.ok(buildNvdaLivePlan({ tests: ["tables", "headings"] }, {}).length === 0);
});

test("announced stops keep transcripts and timing; screenshots are kept for the state and stops needing review", async (context) => {
  const f = await fixture(context);
  assert.equal(await f.session.preparePage(f.page), true);
  const state = await f.session.testState(f.page, { id: "default", url: f.structure.url });
  assert.equal(state.actions.length, 2);
  assert.ok(state.actions.every((action) => action.outcome === "announced" && action.evidence === null && Number.isFinite(action.timing.totalMs)));
  assert.ok(state.evidence);
  assert.equal(f.screenshots.length, 1);
  assert.equal(f.session.finish().timing.focus.commands, 2);
});

test("live NVDA captures state and per-action evidence, cleans up, and deduplicates states", async (context) => {
  const f = await fixture(context, { nvda: { actionScreenshots: "all" } });
  assert.equal(await f.session.preparePage(f.page), true);
  const state = await f.session.testState(f.page, { id: "default", url: f.structure.url });
  assert.equal(state.status, "executed");
  assert.equal(state.stateChanged, false);
  assert.equal(state.actions.length, 2);
  assert.ok(state.actions.every((action) => action.evidence && action.announcements.includes("Account link")));
  assert.equal(f.screenshots.length, 3);
  assert.equal(f.cleaned, true);
  assert.equal(await f.session.testState(f.page, { id: "default" }), state);
  assert.equal(f.tabs, 2);
  assert.equal(f.session.finish().coverage.mode, "headed-windows-live-state");
  assert.equal(f.session.finish().coverage.statesExecuted, 1);
  await f.session.close(); await f.session.close();
  assert.equal(f.closes, 1);
});

test("same-tab UI states share a stable native marker but retain separate state attribution", async (context) => {
  const f = await fixture(context);
  const markers = [];
  const evaluate = f.page.evaluate;
  f.page.evaluate = async (fn, arg) => {
    if (typeof arg === "string") markers.push(arg);
    return evaluate(fn, arg);
  };
  await f.session.preparePage(f.page);
  const first = await f.session.testState(f.page, { id: "default", state: "default" });
  f.structure.dialogs = ["fixture-modal"];
  const second = await f.session.testState(f.page, { id: "dialog", state: "dialog:Fixture" });
  assert.equal(markers.length, 2);
  assert.equal(markers[0], markers[1]);
  assert.match(markers[0], /^RAMBO NVDA fixture [a-f0-9]{12}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(f.session.finish().coverage.statesExecuted, 2);
});

test("live NVDA stops commands on a meaningful modal transition", async (context) => {
  const f = await fixture(context, { afterTab: (structure) => { structure.dialogs = ["changed"]; } });
  await f.session.preparePage(f.page);
  const state = await f.session.testState(f.page, { id: "modal" });
  assert.equal(state.stateChanged, true);
  assert.equal(state.actions.length, 1);
  assert.equal(state.actions[0].outcome, "needs-review");
  assert.equal(f.session.finish().outcome, "needs-review");
});

test("every state starts at the top so later routes do not silently omit their headers", async (context) => {
  const placements = [];
  const f = await fixture(context, { dependencies: { anchor: async (_page, options) => { placements.push(options?.startAt); return true; } } });
  await f.session.preparePage(f.page);
  await f.session.testState(f.page, { id: "first" });
  await f.session.testState(f.page, { id: "second" });
  assert.equal(placements[0], "top");
  assert.ok(placements.every((placement) => placement === "top"));
});

test("each live state establishes native document focus before capture is armed", async (context) => {
  let f;
  const scopes = [];
  f = await fixture(context, { dependencies: { nativeAnchor: async (title, processId) => {
    assert.equal(f.capture.control.capture.active, false);
    assert.equal(processId, 42);
    assert.match(title, /^RAMBO NVDA fixture /);
    scopes.push(title);
    return { ok: true };
  } } });
  await f.session.preparePage(f.page);
  await f.session.testState(f.page, { id: "home" });
  f.structure.dialogs = ["details"];
  await f.session.testState(f.page, { id: "dialog" });
  assert.equal(scopes.length, 2);
  assert.equal(f.session.finish().coverage.statesExecuted, 2);
});

test("a failed native document handoff cannot type keys or claim an executed state", async (context) => {
  const f = await fixture(context, { dependencies: {
    nativeAnchor: async () => ({ ok: false, reason: "Testing Chrome lost foreground" })
  } });
  await f.session.preparePage(f.page);
  const state = await f.session.testState(f.page, { id: "lost-focus" });
  assert.equal(state.status, "blocked");
  assert.match(state.error, /lost foreground/);
  assert.equal(f.tabs, 0);
  assert.equal(f.commands.length, 0);
  assert.equal(f.controls.some((control) => control.capture.active), false);
});

test("a native focus handoff that changes the dialog stops before test commands", async (context) => {
  let f;
  f = await fixture(context, { dependencies: { nativeAnchor: async () => {
    f.structure.dialogs = ["unexpected dialog"];
    return { ok: true };
  } } });
  await f.session.preparePage(f.page);
  const state = await f.session.testState(f.page, { id: "changed-focus" });
  assert.equal(state.status, "blocked");
  assert.equal(state.stateChanged, true);
  assert.equal(f.tabs, 0);
  assert.equal(f.controls.some((control) => control.capture.active), false);
});

test("identical NVDA action and state screenshots share one saved image", async (context) => {
  const f = await fixture(context, { sameScreenshot: true, nvda: { actionScreenshots: "all" } });
  await f.session.preparePage(f.page);
  const state = await f.session.testState(f.page, { id: "same-evidence" });
  assert.ok(state.evidence);
  assert.deepEqual([...new Set([state.evidence, ...state.actions.map((action) => action.evidence)])], [state.evidence]);
});

test("unprepared popups and native foreground failures never claim executed commands", async (context) => {
  const f = await fixture(context, { tabResult: { ok: false, reason: "Wrong foreground process" } });
  const unprepared = await f.session.testState(f.page, { id: "unprepared" });
  assert.equal(unprepared.status, "blocked");
  assert.equal(f.tabs, 0);
  await f.session.preparePage(f.page);
  const blocked = await f.session.testState(f.page, { id: "prepared" });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.checks.focus.status, "blocked");
  assert.equal(f.session.finish().actualExecution, false);
});

test("actual browse-command protocol resets each category but keeps table-cell position", async (context) => {
  const f = await fixture(context, { nvda: { tests: ["reading", "headings", "tables"], headingStops: 2, tableStops: 3 } });
  await f.session.preparePage(f.page);
  const state = await f.session.testState(f.page, { id: "reading" });
  assert.equal(f.tabs, 0);
  assert.deepEqual(f.commands.map((command) => command.kind), ["say-all", "next-heading", "next-heading", "next-table", "next-column", "next-row"]);
  assert.deepEqual(f.commands.map((command) => command.resetPosition), [true, true, false, true, false, false]);
  assert.equal(state.checks.reading.status, "partial");
  assert.equal(state.checks.forms.status, "not-configured");
  assert.equal(state.checks.journeys.status, "not-configured");
  assert.equal(f.session.finish().outcome, "needs-review");
});

test("NVDA startup errors leave crawl integration usable and preserve a blocked-state screenshot", async (context) => {
  const f = await fixture(context, { dependencies: { start: async () => { throw new Error("Add-on needs update"); } } });
  assert.equal(await f.session.preparePage(f.page), false);
  const state = await f.session.testState(f.page, { id: "one" });
  assert.match(state.error, /Add-on needs update/);
  assert.ok(state.evidence);
  assert.equal(f.session.finish().status, "unavailable");
  assert.equal(f.session.finish().actualExecution, false);
});

test("completed reading requires actual completion metadata and stays visible in coverage", async (context) => {
  const f = await fixture(context, { nvda: { tests: ["reading"] } });
  f.capture.receiver.waitForCommand = async () => ({ status: "executed", readingCompletion: "completed", audibleComplete: true });
  await f.session.preparePage(f.page);
  const state = await f.session.testState(f.page, { id: "read-end" });
  assert.equal(state.actions[0].readingCompletion, "completed");
  assert.equal(state.actions[0].audibleComplete, true);
  assert.equal(state.checks.reading.status, "executed");
  assert.equal(f.session.finish().coverage.readingCompleted, 1);
  assert.equal(f.session.finish().coverage.readingIncomplete, 0);
});

test("legacy or timed-out reading never claims completed coverage", async (context) => {
  const f = await fixture(context, { nvda: { tests: ["reading"] } });
  f.capture.receiver.waitForCommand = async () => ({ status: "executed" });
  await f.session.preparePage(f.page);
  await f.session.testState(f.page, { id: "legacy" });
  assert.equal(f.session.finish().coverage.readingCompleted, 0);
  assert.equal(f.session.finish().coverage.readingIncomplete, 1);
  assert.equal(f.session.finish().outcome, "needs-review");
});

test("old installed add-on is rejected for read-to-end instead of silently running its short sample", async (context) => {
  const f = await fixture(context, { nvda: { tests: ["reading"] } });
  f.capture.receiver.readingCompletionSupported = false;
  assert.equal(await f.session.preparePage(f.page), false);
  assert.match(f.session.finish().reason, /install:nvda-addon/);
  assert.equal(f.closes, 1);
});

test("state limits are reported and do not silently claim missing states were tested", async (context) => {
  const f = await fixture(context, { nvda: { maxStates: 1 } });
  await f.session.preparePage(f.page);
  await f.session.testState(f.page, { id: "one" });
  assert.equal(await f.session.testState(f.page, { id: "two" }), null);
  const result = f.session.finish();
  assert.equal(result.coverage.statesDiscovered, 2);
  assert.equal(result.coverage.statesSkippedByLimit, 1);
  assert.equal(result.coverage.statesAttempted, 1);
});

test("with a pause-capable add-on, leaving the test tab pauses NVDA instead of stopping it", async (context) => {
  let active = true;
  const f = await fixture(context, { pauseSupported: true, dependencies: { tabActive: async () => active } });
  assert.equal(f.session.state, "idle");
  assert.equal(await f.session.preparePage(f.page), true);
  assert.equal(f.session.state, "testing");
  active = false;
  assert.equal(await until(() => f.session.state === "paused"), true);
  assert.equal(f.closes, 0, "A pause must keep the owned reader running.");
  const pausedWrite = f.controls.at(-1);
  assert.equal(pausedWrite.lifecycle, "paused");
  assert.equal(pausedWrite.capture.active, false);
  assert.ok(pausedWrite.pauseDeadlineMs > Date.now() && pausedWrite.pauseDeadlineMs <= Date.now() + 120_000, "The default pause deadline is absolute and bounded.");
  assert.match(f.session.pausedReason, /lost focus/);
  assert.ok(f.emitted.some((event) => event.type === "nvda-paused"));
  assert.equal(f.emitted.some((event) => event.type === "nvda-warning"), false, "A pause is not a warning.");
  const writes = f.writes;
  const screenshots = f.screenshots.length;
  const result = await f.session.testState(f.page, { id: "while-paused", state: "default" });
  assert.equal(result.status, "paused");
  assert.equal(result.retryable, true);
  assert.equal(f.tabs, 0, "No Tab may be sent while paused.");
  assert.equal(f.writes, writes, "A paused session must not arm capture.");
  assert.equal(f.screenshots.length, screenshots);
  const summary = f.session.finish();
  assert.equal(summary.stoppedReason, null);
  assert.equal(summary.coverage.statesDiscovered, 0, "A paused attempt is not recorded as a tested state.");
  assert.equal(summary.coverage.statesAttempted, 0);
  assert.equal(summary.coverage.statesNotTestedWhilePaused, 1);
  assert.ok(summary.warnings.some((warning) => /paused/.test(warning)));
  assert.deepEqual(summary.pauses.map(({ source, outcome, resumedAt }) => ({ source, outcome, resumedAt })), [{ source: "tab-focus", outcome: "paused", resumedAt: null }]);
  assert.equal(summary.stopKind, null);
});

test("resume re-establishes a new strict scope, counts the recovery and restarts the tab watch", async (context) => {
  let active = true;
  let checks = 0;
  let fronts = 0;
  const markers = [];
  const f = await fixture(context, { pauseSupported: true, dependencies: {
    tabActive: async () => { checks++; return active; },
    focusWindow: async (title) => { markers.push(title); return { ok: true, processId: 42, windowHandle: "24" }; }
  } });
  assert.equal(await f.session.preparePage(f.page), true);
  f.page.bringToFront = async () => { fronts++; };
  active = false;
  assert.equal(await until(() => f.session.state === "paused"), true);
  const scopeBefore = f.capture.control.scopeId;
  assert.equal(await f.session.resume({ isClosed: () => false }), false, "Only the bound testing tab can be resumed.");
  assert.equal(f.session.state, "paused");
  active = true;
  assert.equal(await f.session.resume(f.page), true);
  assert.equal(f.session.state, "testing");
  assert.equal(f.session.recoveries, 1);
  assert.equal(fronts, 1);
  assert.equal(markers.at(-1), "RAMBO NVDA fixture r1", "Resume pins a fresh marker; the startup marker is gone after navigation.");
  const resumed = f.controls.at(-1);
  assert.equal(resumed.lifecycle, "testing");
  assert.notEqual(resumed.scopeId, scopeBefore);
  assert.equal(resumed.capture.active, false);
  assert.equal(resumed.pauseDeadlineMs, undefined, "A stale deadline must not be latched by the next pause.");
  assert.equal(resumed.browserScope.titleMarker, "RAMBO NVDA fixture r1");
  assert.equal(f.scopeWaits.at(-1), resumed.scopeId);
  assert.ok(f.emitted.some((event) => event.type === "nvda-resumed"));
  const before = checks;
  assert.equal(await until(() => checks >= before + 3), true, "The tab watch restarts after resume.");
  const [pause] = f.session.finish().pauses;
  assert.equal(pause.outcome, "resumed");
  assert.equal(typeof pause.resumedAt, "string");
  assert.equal(f.session.finish().recoveries, 1);
  const state = await f.session.testState(f.page, { id: "after-resume" });
  assert.equal(state.status, "executed");
  active = false;
  assert.equal(await until(() => f.session.state === "paused"), true, "A later departure pauses again.");
  assert.equal(f.closes, 0);
});

test("a different Chrome window answering on resume stops NVDA", async (context) => {
  let active = true;
  let focuses = 0;
  const f = await fixture(context, { pauseSupported: true, dependencies: {
    tabActive: async () => active,
    focusWindow: async () => ({ ok: true, processId: 42, windowHandle: ++focuses <= 2 ? "24" : "99" })
  } });
  assert.equal(await f.session.preparePage(f.page), true);
  active = false;
  assert.equal(await until(() => f.session.state === "paused"), true);
  active = true;
  assert.equal(await f.session.resume(f.page), false);
  assert.equal(f.closes, 1);
  assert.equal(f.session.state, "stopped");
  const summary = f.session.finish();
  assert.match(summary.stoppedReason, /could not be resumed/);
  assert.equal(summary.stopKind, "not-resumed");
  assert.equal(summary.pauses[0].outcome, "stopped");
  assert.equal(f.scopeWaits.length, 1, "No new scope is offered to an unverified window.");
});

test("a failed re-handoff stays paused, and the recovery limit stops NVDA", async (context) => {
  const f = await fixture(context, { pauseSupported: true, nvda: { maxRecoveries: 2 } });
  assert.equal(await f.session.preparePage(f.page), true);
  const pause = async () => {
    f.notifyPaused("Windows Settings took the foreground.", { scopeId: f.capture.control.scopeId });
    assert.equal(await until(() => f.session.state === "paused"), true);
  };
  await pause();
  f.capture.receiver.waitForScope = async () => false;
  assert.equal(await f.session.resume(f.page), false, "A rejected handoff keeps the session paused.");
  assert.equal(f.session.state, "paused");
  assert.equal(f.controls.at(-1).lifecycle, "paused", "The controller returns the add-on to the paused lifecycle.");
  assert.ok(f.controls.at(-1).pauseDeadlineMs > Date.now());
  f.capture.receiver.waitForScope = async () => true;
  assert.equal(await f.session.resume(f.page), true);
  assert.equal(f.session.recoveries, 1);
  await pause();
  assert.equal(await f.session.resume(f.page, { countsTowardLimit: false }), true, "Departures the agent caused do not count.");
  assert.equal(f.session.recoveries, 1);
  await pause();
  assert.equal(await f.session.resume(f.page), false);
  assert.equal(f.closes, 1);
  assert.match(f.session.finish().stoppedReason, /could not be resumed/);
  assert.equal(f.session.finish().pauses.length, 3);
  assert.equal(f.session.finish().pauses.at(-1).outcome, "stopped");
});

test("closing the testing tab while NVDA is paused releases it exactly once", async (context) => {
  let active = true;
  const f = await fixture(context, { pauseSupported: true, dependencies: { tabActive: async () => active } });
  assert.equal(await f.session.preparePage(f.page), true);
  active = false;
  assert.equal(await until(() => f.session.state === "paused"), true);
  f.page.emit("close");
  await f.session.close();
  await f.session.close();
  assert.equal(f.closes, 1);
  assert.equal(f.session.state, "stopped");
  assert.equal(await f.session.resume(f.page), false);
  const summary = f.session.finish();
  assert.equal(summary.stopKind, "tab-closed");
  assert.equal(summary.pauses[0].outcome, "stopped");
  assert.equal((await f.session.testState(f.page, { id: "after-close" })).status, "blocked");
  assert.equal(f.tabs, 0);
});

test("an add-on pause report pauses the session, stale scope reports are ignored, and old add-ons still stop", async (context) => {
  const f = await fixture(context, { pauseSupported: true });
  assert.equal(await f.session.preparePage(f.page), true);
  f.notifyPaused("Late report for a replaced scope.", { scopeId: "replaced-scope" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.session.state, "testing");
  f.notifyPaused("Windows Settings took the foreground.", { scopeId: f.capture.control.scopeId });
  assert.equal(await until(() => f.session.state === "paused"), true);
  assert.equal(f.session.pausedReason, "Windows Settings took the foreground.");
  assert.equal(f.session.finish().pauses[0].source, "addon");
  assert.equal(f.closes, 0);

  const legacy = await fixture(context, { pauseSupported: false });
  assert.equal(await legacy.session.preparePage(legacy.page), true);
  legacy.notifyPaused("The testing Chrome window is not in front.", {});
  assert.equal(await until(() => legacy.closes === 1), true, "Without the capability a pause report fails closed.");
  assert.equal(legacy.session.state, "stopped");
});

test("an unacknowledged capture with a pause-capable add-on pauses instead of ending the run", async (context) => {
  const f = await fixture(context, { pauseSupported: true });
  f.capture.receiver.waitForCapture = async () => false;
  assert.equal(await f.session.preparePage(f.page), true);
  const result = await f.session.testState(f.page, { id: "lost-ack" });
  assert.equal(result.status, "interrupted");
  assert.equal(result.interruptedByPause, true);
  assert.equal(f.session.state, "paused");
  assert.equal(f.session.finish().pauses[0].source, "ack-timeout");
  assert.equal(f.closes, 0);
  assert.equal(f.tabs, 0);
});

test("a state interrupted by a pause retains evidence and the same id is retried after resume", async (context) => {
  let active = true;
  const f = await fixture(context, { pauseSupported: true, nvda: { maxStates: 1 }, dependencies: { tabActive: async () => active },
    afterTab: (_structure, tabs) => { if (tabs === 1) active = false; } });
  assert.equal(await f.session.preparePage(f.page), true);
  const interrupted = await f.session.testState(f.page, { id: "retry-me", state: "default" });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.retryable, true);
  assert.equal(interrupted.interruptedByPause, true);
  assert.equal(f.tabs, 1, "No command is sent after the pause.");
  assert.equal(f.capture.control.capture.active, false, "The interrupted attempt still disarms capture.");
  assert.equal(f.cleaned, true);
  assert.equal(f.session.finish().states.length, 1);
  assert.ok(interrupted.evidence);
  assert.equal(interrupted.actions.length, 1);
  assert.deepEqual(interrupted.actions[0].announcements, ["Account link"]);
  active = true;
  assert.equal(await f.session.resume(f.page), true);
  const retried = await f.session.testState(f.page, { id: "retry-me", state: "default" });
  assert.equal(retried.status, "executed", "The retried id is not blocked by the earlier attempt or the state limit.");
  assert.equal(retried.actions.length, 3, "Original evidence and both retried focus actions remain available.");
  assert.equal(retried.attempts.length, 2);
  const summary = f.session.finish();
  assert.equal(summary.states.length, 1);
  assert.equal(summary.coverage.statesNotTestedWhilePaused, 0);
  assert.equal(summary.warnings.some((warning) => /paused/.test(warning)), false);
});

test("recovery preserves completed reading and does not repeat it before retrying focus", async (context) => {
  let f;
  let interrupted = false;
  f = await fixture(context, { pauseSupported: true, nvda: { tests: ["reading", "focus"], tabStops: 2 },
    dependencies: { nativeFocus: async () => {
      if (!interrupted) {
        interrupted = true;
        f.notifyPaused("Focus moved outside the test window.", { scopeId: f.capture.control.scopeId, detail: "Native foreground mismatch" });
      }
      return { ok: false, reason: "Outside the test window" };
    } } });
  f.capture.receiver.waitForCommand = async () => ({ status: "executed", readingCompletion: "completed", audibleComplete: true });
  await f.session.preparePage(f.page);
  const first = await f.session.testState(f.page, { id: "read-then-pause" });
  assert.equal(first.status, "interrupted");
  assert.equal(f.session.finish().coverage.readingCompleted, 1);
  assert.equal(f.session.finish().actualExecution, true);
  assert.equal(f.session.finish().status, "interrupted");
  assert.equal(f.session.finish().outcome, "partially-tested");
  assert.equal(f.session.finish().pauses[0].detail, "Native foreground mismatch");
  await f.session.resume(f.page);
  const second = await f.session.testState(f.page, { id: "read-then-pause" });
  assert.equal(second.status, "executed");
  assert.equal(f.commands.filter((command) => command.kind === "say-all").length, 1);
  assert.equal(second.attempts.length, 2);
});

test("verified Chrome toolbar focus ends Tab traversal without another native key", async (context) => {
  let f;
  f = await fixture(context, { pauseSupported: true, nvda: { tests: ["reading", "focus"], tabStops: 12 },
    dependencies: { nativeFocus: async () => ({ ok: true, inDocument: f.tabs < 2 }) } });
  f.capture.receiver.waitForCommand = async () => ({ status: "executed", readingCompletion: "completed", audibleComplete: true });
  await f.session.preparePage(f.page);
  const first = await f.session.testState(f.page, { id: "document-end" });
  assert.equal(f.tabs, 2);
  assert.equal(first.focusBoundary, "document-end");
  assert.equal(first.actions.filter((action) => action.kind === "focus").length, 1, "The toolbar stop is not website evidence.");
  assert.equal(first.retryable, true);
  assert.equal(await f.session.resume(f.page), true);
  const resumed = await f.session.testState(f.page, { id: "document-end" });
  assert.equal(resumed.status, "executed");
  assert.equal(f.tabs, 2, "Neither recovery nor the completed category sends another Tab.");
  assert.equal(f.commands.length, 1, "Completed reading is not repeated.");
  assert.equal(f.session.recoveries, 0, "Normal document boundaries must not consume the unexpected-focus recovery budget.");
});

test("normal document boundaries remain recoverable across many states with no unexpected-focus retries", async (context) => {
  let f;
  f = await fixture(context, { pauseSupported: true, nvda: { maxRecoveries: 0 },
    dependencies: { nativeFocus: async () => ({ ok: true, inDocument: f.tabs % 2 === 1 }) } });
  await f.session.preparePage(f.page);
  for (let index = 0; index < 5; index++) {
    const meta = { id: `short-state-${index}` };
    const first = await f.session.testState(f.page, meta);
    assert.equal(first.focusBoundary, "document-end");
    assert.equal(await f.session.resume(f.page), true);
    assert.equal((await f.session.testState(f.page, meta)).status, "executed");
  }
  assert.equal(f.tabs, 10);
  assert.equal(f.session.recoveries, 0);
  assert.equal(f.session.finish().coverage.statesExecuted, 5);
  f.notifyPaused("Another application has focus.", { scopeId: f.capture.control.scopeId });
  assert.equal(await f.session.resume(f.page), false, "A real focus loss still respects the configured zero-retry limit.");
});

test("a changed state after handoff keeps prior speech but cannot resume saved commands", async (context) => {
  let f;
  f = await fixture(context, { pauseSupported: true, dependencies: { speechWait: async () => {
    if (f.tabs === 1) f.notifyPaused("Focus lost.", { scopeId: f.capture.control.scopeId });
  } } });
  await f.session.preparePage(f.page);
  const first = await f.session.testState(f.page, { id: "changed-on-retry" });
  assert.equal(first.status, "interrupted");
  assert.equal(await f.session.resume(f.page), true);
  f.structure.dialogs = ["unexpected dialog"];
  const retried = await f.session.testState(f.page, { id: "changed-on-retry" });
  assert.equal(retried.status, "interrupted");
  assert.equal(retried.stateChanged, true);
  assert.equal(retried.retryable, false);
  assert.equal(f.tabs, 1);
  assert.deepEqual(retried.actions[0].announcements, ["Account link"]);
  assert.equal(f.session.finish().outcome, "partially-tested");
});

test("an unverified native scope is not accepted as a normal document boundary", async (context) => {
  let f;
  f = await fixture(context, { pauseSupported: true, dependencies: { nativeFocus: async () => {
    f.notifyPaused("Another Chrome tab became active.", { scopeId: f.capture.control.scopeId });
    return { ok: false, inDocument: false };
  } } });
  await f.session.preparePage(f.page);
  const result = await f.session.testState(f.page, { id: "other-tab" });
  assert.equal(result.status, "interrupted");
  assert.equal(result.focusBoundary, undefined);
  assert.equal(result.finishedChecks.includes("focus"), false);
  assert.equal(f.tabs, 1);
});

test("recovery restores native focus before checking webpage focus and rejects changed states", async (context) => {
  let f;
  let active = true;
  let changed = false;
  f = await fixture(context, { pauseSupported: true, dependencies: {
    tabActive: async () => active,
    nativeAnchor: async () => { active = true; if (changed) f.structure.dialogs = ["new dialog"]; return { ok: true }; }
  } });
  await f.session.preparePage(f.page);
  active = false;
  f.notifyPaused("Toolbar has focus.", { scopeId: f.capture.control.scopeId });
  assert.equal(await f.session.resume(f.page), true);
  active = false;
  f.notifyPaused("Toolbar has focus again.", { scopeId: f.capture.control.scopeId });
  changed = true;
  assert.equal(await f.session.resume(f.page), false);
  assert.equal(f.session.state, "paused");
  assert.equal(f.tabs, 0);
});

test("pause support does not relax the one-time startup handoff", async (context) => {
  let checks = 0;
  const f = await fixture(context, { pauseSupported: true, dependencies: { tabActive: async () => ++checks === 1 } });
  assert.equal(await f.session.preparePage(f.page), false);
  assert.equal(f.closes, 1);
  assert.equal(f.session.state, "stopped");
  assert.match(f.session.finish().stoppedReason, /lost focus/);
  assert.equal(f.session.finish().pauses.length, 0);
});

test("NVDA recovery and pause limits are bounded configuration", () => {
  const saved = { recoveries: process.env.NVDA_MAX_RECOVERIES, pause: process.env.NVDA_MAX_PAUSE_MS };
  delete process.env.NVDA_MAX_RECOVERIES;
  delete process.env.NVDA_MAX_PAUSE_MS;
  try {
    assert.equal(getConfig().nvda.maxRecoveries, 3);
    assert.equal(getConfig().nvda.maxPauseMs, 120_000);
    assert.equal(getConfig({ nvda: { maxRecoveries: 0 } }).nvda.maxRecoveries, 0);
    assert.equal(getConfig({ nvda: { maxRecoveries: 99 } }).nvda.maxRecoveries, 10);
    assert.equal(getConfig({ nvda: { maxRecoveries: "invalid" } }).nvda.maxRecoveries, 3);
    assert.equal(getConfig({ nvda: { maxPauseMs: 5 } }).nvda.maxPauseMs, 10_000);
    assert.equal(getConfig({ nvda: { maxPauseMs: 9_999_999 } }).nvda.maxPauseMs, 600_000);
    process.env.NVDA_MAX_RECOVERIES = "5";
    process.env.NVDA_MAX_PAUSE_MS = "30000";
    assert.equal(getConfig().nvda.maxRecoveries, 5);
    assert.equal(getConfig().nvda.maxPauseMs, 30_000);
  } finally {
    for (const [name, value] of [["NVDA_MAX_RECOVERIES", saved.recoveries], ["NVDA_MAX_PAUSE_MS", saved.pause]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

async function tabFixture(context, options = {}) {
  let active;
  const detached = [];
  const focused = [];
  const f = await fixture(context, { pauseSupported: true, ...options, dependencies: {
    trackFocus: async (page) => ({ detach: async () => { detached.push(page); } }),
    focusWindow: async (title) => { focused.push({ page: active, title }); return { ok: true, processId: 42, windowHandle: active?.nativeHandle || "24" }; },
    inspect: async (page) => ({ url: page.url(), dialogs: page.dialogs || [], tabs: [], expanded: [], frames: [] }),
    ...options.dependencies
  } });
  const browserContext = { browser: () => f.browser };
  f.page.context = () => browserContext;
  f.page.nativeHandle = "24";
  f.page.bringToFront = async () => { active = f.page; };
  await f.session.preparePage(f.page);
  f.page.url = () => "https://fixture.test/parent";
  const child = Object.assign(new EventEmitter(), {
    context: () => browserContext, opener: async () => f.page, url: () => "https://fixture.test/child", nativeHandle: "48",
    bringToFront: async () => {
      assert.equal(f.controls.at(-1).lifecycle, "paused", "Capture must be disarmed before another tab is activated.");
      assert.equal(f.controls.at(-1).capture.active, false);
      active = child;
    },
    evaluate: f.page.evaluate, screenshot: f.page.screenshot,
    goto: async () => { assert.fail("A retained tab must never be reloaded during handoff."); }
  });
  return { ...f, child, detached, focused, browserContext };
}

test("controlled application popup handoff registers its exact window and returns to the retained original tab", async (context) => {
  const f = await tabFixture(context);
  const startupScope = f.capture.control.scopeId;
  assert.equal(await f.session.switchToPage(f.child, { opener: f.page }), true);
  const childScope = f.capture.control.scopeId;
  assert.notEqual(childScope, startupScope);
  assert.equal(f.capture.control.browserScope.windowHandle, "48");
  const childState = await f.session.testState(f.child, { id: "child-state" });
  assert.equal(childState.status, "executed");
  const childMarker = f.controls.find((entry) => entry.capture.active)?.capture.titleMarker;
  assert.equal(await f.session.switchToPage(f.page), true);
  assert.equal(f.capture.control.browserScope.windowHandle, "24");
  assert.notEqual(f.capture.control.scopeId, childScope);
  const parentState = await f.session.testState(f.page, { id: "parent-return" });
  assert.equal(parentState.status, "executed");
  const parentMarker = f.controls.filter((entry) => entry.capture.active).at(-1).capture.titleMarker;
  assert.notEqual(parentMarker, childMarker, "Different pages must never share their active-command title marker.");
  assert.equal(f.session.recoveries, 0, "Expected application tab transfers do not consume focus-loss retries.");
  assert.equal(f.child.listenerCount("close"), 0, "The owned child can be closed after the return handshake.");
  f.child.emit("close");
  assert.equal(f.session.state, "testing");
  await f.session.close();
  assert.equal(f.detached.filter((page) => page === f.page).length, 1);
  assert.equal(f.detached.filter((page) => page === f.child).length, 1);
  assert.equal(f.page.listenerCount("close"), 0);
});

test("application tab handoff rejects unrelated tabs, other contexts and external origins without focus changes", async (context) => {
  for (const variant of ["no-opener", "wrong-opener", "context", "origin"]) {
    const f = await tabFixture(context);
    if (variant === "wrong-opener") f.child.opener = async () => null;
    if (variant === "context") f.child.context = () => ({ browser: () => f.browser });
    if (variant === "origin") f.child.url = () => "https://external.test/";
    const focusCount = f.focused.length;
    const writes = f.controls.length;
    assert.equal(await f.session.switchToPage(f.child, variant === "no-opener" ? {} : { opener: f.page }), false);
    assert.equal(f.focused.length, focusCount);
    assert.equal(f.controls.length, writes);
    assert.equal(f.session.state, "testing");
  }
});

test("a pending disarm acknowledgement prevents any child tab focus", async (context) => {
  const f = await tabFixture(context);
  let acknowledge;
  const write = f.capture.write;
  f.capture.write = async () => {
    await write();
    if (f.capture.control.lifecycle === "paused" && !acknowledge) await new Promise((resolve) => { acknowledge = resolve; });
  };
  const transfer = f.session.switchToPage(f.child, { opener: f.page });
  await until(() => Boolean(acknowledge));
  assert.equal(f.focused.some((entry) => entry.page === f.child), false);
  acknowledge();
  assert.equal(await transfer, true);
});

test("a rejected child scope stays paused and the original scope can be explicitly restored", async (context) => {
  const f = await tabFixture(context);
  const waitForScope = f.capture.receiver.waitForScope;
  f.capture.receiver.waitForScope = async () => false;
  assert.equal(await f.session.switchToPage(f.child, { opener: f.page }), false);
  assert.equal(f.session.state, "paused");
  assert.equal(f.capture.control.lifecycle, "paused");
  assert.equal(f.capture.control.capture.active, false);
  assert.equal(f.child.listenerCount("close"), 0);
  assert.equal(f.detached.filter((page) => page === f.child).length, 1);
  f.capture.receiver.waitForScope = waitForScope;
  assert.equal(await f.session.switchToPage(f.page), true);
  assert.equal(f.capture.control.browserScope.windowHandle, "24");
  assert.equal(f.session.state, "testing");
});

test("closing the original tab while its child is tested still stops the owned reader", async (context) => {
  const f = await tabFixture(context);
  assert.equal(await f.session.switchToPage(f.child, { opener: f.page }), true);
  f.page.emit("close");
  await until(() => f.session.state === "stopped");
  assert.equal(f.session.finish().stopKind, "tab-closed");
  assert.equal(await f.session.switchToPage(f.page), false);
});

test("a retained parent state changed during child testing is not silently resumed", async (context) => {
  const f = await tabFixture(context);
  assert.equal(await f.session.switchToPage(f.child, { opener: f.page }), true);
  f.page.dialogs = ["new-modal"];
  assert.equal(await f.session.switchToPage(f.page), false);
  assert.equal(f.session.state, "paused");
  assert.match(f.session.finish().warnings.join(" "), /retained application tab changed state/);
  assert.equal(f.capture.control.capture.active, false);
});

test("redirecting outside the application during a handoff leaves NVDA paused", async (context) => {
  const f = await tabFixture(context);
  const bringToFront = f.child.bringToFront;
  f.child.bringToFront = async () => { await bringToFront(); f.child.url = () => "https://external.test/redirect"; };
  assert.equal(await f.session.switchToPage(f.child, { opener: f.page }), false);
  assert.equal(f.session.state, "paused");
  assert.equal(f.capture.control.capture.active, false);
});
