import { randomBytes } from "node:crypto";
import { liveStateIdentity } from "./live-state-model.js";

function pinResumeMarker(value) {
  const previous = window.__ramboNvdaResume;
  previous?.observer?.disconnect();
  const saved = previous || { title: document.title, focus: document.activeElement, scrollX, scrollY };
  const observer = new MutationObserver(() => { if (document.title !== value) document.title = value; });
  window.__ramboNvdaResume = { ...saved, observer };
  document.title = value;
  observer.observe(document.head || document.documentElement, { subtree: true, characterData: true, childList: true });
}

function restoreResumeMarker() {
  const saved = window.__ramboNvdaResume;
  if (!saved) return;
  saved.observer?.disconnect();
  document.getElementById("rambo-nvda-focus-anchor")?.remove();
  document.title = saved.title;
  if (saved.focus?.isConnected && saved.focus !== document.body) saved.focus.focus?.({ preventScroll: true });
  window.scrollTo(saved.scrollX, saved.scrollY);
  delete window.__ramboNvdaResume;
}

// Performs one verified native handoff. The live controller owns retry limits,
// pause deadlines and recovery counters; this module never retries commands.
export async function restoreNativeScope({ page, window, title, capture, runtime,
  controlled, newPage, applicationOrigin, isClosed, isStopped, stop, httpOrigin, marker }) {
  const expectedState = liveStateIdentity(await runtime.inspect(page));
  await page.bringToFront();
  if (isClosed()) return false;
  await page.evaluate(pinResumeMarker, title);
  marker.pinned = true;
  const focused = await runtime.focusWindow(title);
  if (isClosed()) return false;
  if (!focused.ok) throw new Error(focused.reason || "The testing Chrome window could not be brought to the front.");
  if (!Number.isInteger(focused.processId) || focused.processId <= 0 || !/^\d+$/.test(String(focused.windowHandle)) || BigInt(focused.windowHandle) <= 0n) {
    throw new Error("The testing Chrome window did not return a valid native scope.");
  }
  if (!newPage && (focused.processId !== window.processId || String(focused.windowHandle) !== String(window.windowHandle))) {
    await stop("NVDA could not be resumed: a different Chrome window answered for the testing tab; NVDA stopped. Remaining screen-reader tests were canceled.", "not-resumed");
    return false;
  }
  // Restore native document focus before checking document.hasFocus():
  // toolbar focus makes that false even in the correct foreground tab.
  // This only focuses our marker; it never sends pane-switching keys.
  if (!await runtime.anchor(page, { startAt: "top", allowNativeHandoff: true })) throw new Error("The testing page could not receive document focus.");
  const nativeFocus = await runtime.nativeAnchor(title, focused.processId);
  if (!nativeFocus.ok) throw new Error(nativeFocus.reason || "The testing document could not regain native focus.");
  if (await runtime.tabActive(page) === false) throw new Error("The testing tab is still not in front.");
  if (isClosed()) return false;
  if (controlled && httpOrigin(page.url()) !== applicationOrigin) throw new Error("The application tab left the approved origin during handoff.");
  if (liveStateIdentity(await runtime.inspect(page)) !== expectedState) throw new Error("Changing tab focus altered the application state; the NVDA handoff was not accepted.");
  capture.control.browserScope = { processId: focused.processId, windowHandle: String(focused.windowHandle), titleMarker: title };
  capture.control.lifecycle = "testing";
  capture.control.scopeId = randomBytes(8).toString("hex");
  capture.control.capture = { active: false };
  delete capture.control.pauseDeadlineMs;
  await capture.write();
  if (!await capture.receiver.waitForScope(capture.control.scopeId, 2500)) {
    const refused = capture.receiver.paused?.scopeId === capture.control.scopeId ? capture.receiver.paused : null;
    throw new Error(capture.stoppedReason || (refused ? `NVDA refused the resumed scope (${refused.detail || refused.reason}).` : "NVDA did not confirm the testing scope."));
  }
  if (isClosed() || isStopped()) return false;
  await page.evaluate(restoreResumeMarker);
  if (liveStateIdentity(await runtime.inspect(page)) !== expectedState) throw new Error("Restoring tab focus altered the application state; the NVDA handoff was not accepted.");
  marker.pinned = false;
  return focused;
}

// Caller must disarm/re-pause or stop the reader before restoring a failed scope.
export async function cleanupScopeMarker(page, marker) {
  if (marker.pinned) await page.evaluate(restoreResumeMarker).catch(() => {});
}
