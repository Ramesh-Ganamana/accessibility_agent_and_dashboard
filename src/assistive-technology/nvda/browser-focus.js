import { chromium } from "playwright";
import { describeFocusedControl } from "../required-fields.js";
import { firstLine } from "./text.js";

export async function launchHeadedBrowser(requested) {
  const normalized = String(requested || "auto").toLowerCase();
  const candidates = normalized === "auto"
    ? ["msedge", "chrome", null]
    : normalized === "bundled" ? [null] : [normalized];
  const errors = [];
  for (const channel of candidates) {
    try {
      return await chromium.launch({ headless: false, args: ["--start-maximized"], ...(channel ? { channel } : {}) });
    } catch (error) {
      errors.push(`${channel || "bundled"}: ${firstLine(error.message)}`);
    }
  }
  throw new Error(`A headed browser could not start for NVDA. ${errors.join(" | ")}`);
}

export async function keepWindowTitle(page, title) {
  await page.evaluate((value) => {
    document.title = value;
    const titleElement = document.querySelector("title") || document.head.appendChild(document.createElement("title"));
    titleElement.textContent = value;
    new MutationObserver(() => {
      if (document.title !== value) document.title = value;
    }).observe(document.head, { childList: true, characterData: true, subtree: true });
  }, title);
}

// startAt "main" places the anchor at the start of the main content so Tab and
// browse commands skip the site header already covered on an earlier state.
export async function establishPageKeyboardFocus(page, { startAt = "top", allowNativeHandoff = false } = {}) {
  return page.evaluate(({ startAt, allowNativeHandoff }) => {
    const id = "rambo-nvda-focus-anchor";
    let anchor = document.getElementById(id);
    if (!anchor) {
      // A custom tag does not change span/div nth-of-type replay selectors.
      anchor = document.createElement("rambo-nvda-focus-anchor");
      anchor.id = id;
      anchor.tabIndex = 0;
      anchor.setAttribute("aria-label", "Accessibility test start");
      anchor.setAttribute("data-rambo-nvda-anchor", "true");
      anchor.style.cssText = "position:fixed;left:0;top:0;width:12px;height:12px;overflow:hidden;opacity:0.01;z-index:2147483647;";
      const visible = (node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden";
      const modal = [...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[role="menu"]')].filter(visible).at(-1);
      // A fixed (0,0) child of a centered HTML dialog sits outside its visible
      // bounds. Chrome can then omit it from NVDA's browse buffer even though
      // DOM focus succeeds. Keep the anchor inside the active surface.
      if (modal) anchor.style.cssText = "position:relative;display:block;width:12px;height:1px;margin:0;padding:0;overflow:hidden;opacity:0.01;";
      const main = startAt === "main" ? [...document.querySelectorAll('main,[role="main"]')].find(visible) : null;
      (modal || main || document.body).prepend(anchor);
    }
    // No click: click-away handlers must not close an auto-open baseline dialog.
    window.focus();
    anchor?.focus?.({ preventScroll: true });
    return Boolean(anchor && document.activeElement === anchor && (allowNativeHandoff || document.hasFocus()));
  }, { startAt, allowNativeHandoff });
}

export async function describeFocusedElement(page) {
  return page.evaluate(describeFocusedControl).catch(() => ({ documentFocused: false, tag: "unknown", role: "", name: "" }));
}
