import { randomBytes } from "node:crypto";
import { captureApplicationState } from "../scanner/actions.js";

// Only application-created child tabs enter this scope. Retain the actual
// opener Page and its DOM; returning never navigates or replays that page.
export async function inspectApplicationTab({ opener, popup, applicationUrl, nvda, visit, emit = () => {} }) {
  if (popup === opener || popup.context() !== opener.context() || await popup.opener() !== opener) {
    return { status: "skipped", reason: "unowned-tab" };
  }
  const marker = `__ramboTabReturn_${randomBytes(8).toString("hex")}`;
  let saved = false;
  let before;
  let switched = false;
  let result = { status: "skipped", reason: "tab-closed" };
  try {
    if (opener.isClosed() || popup.isClosed()) return result;
    before = await captureApplicationState(opener);
    await opener.evaluate((key) => {
      Object.defineProperty(window, key, { configurable: true, value: { focus: document.activeElement, x: scrollX, y: scrollY } });
    }, marker);
    saved = true;
    const target = new URL(popup.url());
    if (!["http:", "https:"].includes(target.protocol) || target.origin !== new URL(applicationUrl).origin) {
      result = { status: "skipped", reason: "external-origin" };
      emit({ type: "action-skip", message: "Skipped a new tab outside the application; returning to the original tab.", url: popup.url() });
      return result;
    }
    emit({ type: "tab-switch", message: "Inspecting the new application tab; the original tab is kept open.", url: popup.url() });
    if (nvda) {
      switched = Boolean(await nvda.switchToPage?.(popup, { opener }));
      if (!switched) emit({ type: "nvda-warning", message: "NVDA could not verify the new tab. Automated checks will continue there without attributing NVDA speech to it.", url: popup.url() });
    }
    await popup.bringToFront();
    result = await visit(popup, switched ? nvda : null) || { status: "scanned" };
    return result;
  } finally {
    if (!opener.isClosed()) {
      // Reverse the acknowledged reader scope before closing the child, so its
      // lifetime guard cannot mistake intentional cleanup for a canceled run.
      if (nvda) {
        try {
          const returned = switched ? await nvda.switchToPage(opener) : await nvda.resume?.(opener, { countsTowardLimit: false });
          if (returned === false) emit({ type: "nvda-warning", message: "Returned to the original tab, but NVDA could not verify its resumed scope." });
        } catch (error) {
          await nvda.close().catch(() => {});
          emit({ type: "nvda-warning", message: `NVDA tab return failed: ${error.message}` });
        }
      }
      await opener.bringToFront().catch(() => {});
      if (saved) await opener.evaluate((key) => {
        const state = window[key];
        if (state?.focus?.isConnected && document.activeElement !== state.focus) state.focus.focus?.({ preventScroll: true });
        if (state) window.scrollTo(state.x, state.y);
        delete window[key];
      }, marker).catch(() => {});
      const after = await captureApplicationState(opener).catch(() => null);
      result.parentStatePreserved = Boolean(before && after?.fingerprint === before.fingerprint);
      emit({ type: result.parentStatePreserved ? "tab-return" : "crawl-warning",
        message: result.parentStatePreserved ? "Returned to the original tab and state; continuing the crawl."
          : "Returned to the original tab. Its application state changed while the child tab was open; the next action will recheck that state.", url: opener.url() });
    } else {
      await nvda?.close().catch(() => {});
      result.parentStatePreserved = false;
    }
    await popup.close().catch(() => {});
  }
}
