import { createHash } from "node:crypto";
import { detectPageAccessFailure, navigateAndWait, waitForPageReady } from "../browser/readiness.js";

const UNSAFE_ACTION = /\b(delete|remove|destroy|erase|logout|log\s*out|sign\s*out|pay|purchase|buy|checkout|place\s+order|submit|save|create|register|sign\s*up|enroll|join\s+now|new\s+account|open\s+account|add|approve|reject|confirm|send|publish|upload|unsubscribe|disable|terminate|cancel\s+(?:account|subscription|order)|reset|clear\s+all)\b/i;
const MUTATING_ROLE = /^(checkbox|radio|switch|option|slider|spinbutton)$/i;

export async function inventorySafeActions(page, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 4));
  let actions = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const discovered = await inventorySafeActionsOnce(page);
    actions = discovered.filter((action) => !isExcludedActionLabel(action.label, options.excludeLabels));
    if (discovered.length) return actions;
    if (attempt < attempts - 1) {
      await waitForPageReady(page, { timeout: 5_000, settleMs: 350 });
      await page.waitForTimeout(350).catch(() => {});
    }
  }
  return actions;
}

async function inventorySafeActionsOnce(page) {
  const actions = [];
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    const entries = await frame.evaluate(({ frameIndex }) => {
      const candidates = [];
      const selector = [
        "a[href]",
        "area[href]",
        "button",
        'input[type="button"]',
        '[role="button"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="tab"]',
        '[role="treeitem"]',
        '[aria-haspopup]',
        "[onclick]",
        '[tabindex]:not([tabindex="-1"])',
        "div",
        "span"
      ].join(",");
      const visit = (root) => {
        root.querySelectorAll?.(selector).forEach((element) => candidates.push(element));
        root.querySelectorAll?.("*").forEach((element) => { if (element.shadowRoot) visit(element.shadowRoot); });
      };
      const domPath = (element) => {
        const parts = [];
        let current = element;
        while (current && parts.length < 10) {
          if (current.nodeType !== Node.ELEMENT_NODE) break;
          let part = current.localName;
          if (current.id) part += `#${current.id}`;
          else {
            const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.localName === current.localName) : [];
            if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
          }
          parts.unshift(part);
          const root = current.getRootNode();
          current = current.parentElement || (root instanceof ShadowRoot ? root.host : null);
          if (root instanceof ShadowRoot) parts.unshift("::shadow");
        }
        return parts.join(" > ");
      };
      const isVisible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width >= 2 && rect.height >= 2;
      };
      const isClickable = (element) => {
        const tag = element.localName;
        const role = element.getAttribute("role") || "";
        return tag === "a" || tag === "area" || tag === "button" || (tag === "input" && element.type === "button") || /^(button|link|menuitem|tab|treeitem)$/.test(role)
          || element.hasAttribute("onclick") || element.hasAttribute("aria-haspopup") || getComputedStyle(element).cursor === "pointer";
      };
      visit(document);
      return [...new Set(candidates)].flatMap((element, index) => {
        const tag = element.localName;
        if (!isVisible(element) || !isClickable(element) || element.matches(":disabled,[aria-disabled='true']")) return [];
        if (element.isContentEditable || element.closest("[contenteditable='true']")) return [];
        const role = element.getAttribute("role") || (tag === "button" ? "button" : tag === "a" || tag === "area" ? "link" : "clickable");
        const type = String(element.type || element.getAttribute("type") || "").toLowerCase();
        const label = (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || element.value || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (!label || type === "submit" || type === "reset" || element.closest("form") && tag === "input") return [];
        if ((tag === "div" || tag === "span") && !element.hasAttribute("onclick") && !element.hasAttribute("role") && element.tabIndex < 0) {
          const parent = element.parentElement;
          const parentLabel = (parent?.getAttribute("aria-label") || parent?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
          if (parent && getComputedStyle(parent).cursor === "pointer" && parentLabel === label) return [];
        }
        const key = `clarity-${frameIndex}-${index}`;
        element.setAttribute("data-clarity-action-key", key);
        return [{
          key,
          frameIndex,
          frameUrl: location.href,
          tag,
          role,
          type,
          label,
          path: domPath(element),
          inForm: Boolean(element.closest("form")),
          hasPopup: element.getAttribute("aria-haspopup") || "",
          expanded: element.getAttribute("aria-expanded")
        }];
      });
    }, { frameIndex }).catch(() => []);

    for (const entry of entries) {
      const unsafe = UNSAFE_ACTION.test(entry.label) || MUTATING_ROLE.test(entry.role) || entry.inForm && /^(button|clickable)$/.test(entry.role) && !/\b(next|previous|continue|back|open|view|details|menu|tab)\b/i.test(entry.label);
      if (unsafe) continue;
      actions.push({ ...entry, signature: actionSignature(entry) });
    }
  }
  return deduplicate(actions);
}

export async function clickSafeAction(page, expectedAction, options = {}) {
  const currentActions = await inventorySafeActions(page, { attempts: 2 });
  const action = currentActions.find((candidate) => candidate.signature === expectedAction.signature);
  if (!action) return { clicked: false, reason: "control-not-found" };
  const frame = resolveFrame(page, action);
  if (!frame) return { clicked: false, reason: "frame-not-found" };
  const locator = frame.locator(`[data-clarity-action-key="${action.key}"]`).first();
  let popup = null;
  const capturePopup = (opened) => { popup = opened; };
  page.on("popup", capturePopup);
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 3_000 });
    await locator.click({ timeout: 5_000 });
    await page.waitForTimeout(150);
    const readyTimeout = Number(options.readyTimeout ?? 50_000);
    const ready = popup
      ? await waitForPageReady(popup, { timeout: readyTimeout, shellWaitMs: readyTimeout, settleMs: 700 })
      : await waitForPageReady(page, { timeout: readyTimeout, shellWaitMs: readyTimeout, settleMs: 700 });
    if (!ready) {
      if (popup) await popup.close().catch(() => {});
      return { clicked: false, action, popup: null, reason: "page-readiness-timeout" };
    }
    return { clicked: true, action, popup };
  } catch (error) {
    return { clicked: false, action, reason: error.message };
  } finally {
    page.off("popup", capturePopup);
  }
}

export async function restoreActionPath(page, baseUrl, path, options = {}) {
  const rootIsAlreadyOpen = await isExpectedRootState(page, baseUrl, options.expectedRootFingerprint);
  if (!rootIsAlreadyOpen) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
  }
  let baseReady = rootIsAlreadyOpen || await isExpectedRootState(page, baseUrl, options.expectedRootFingerprint);
  // Dropdowns, accordions, and harmless panels can change the fingerprint while
  // leaving the original navigation controls usable. Do not reload a protected
  // SPA route merely because that presentation state did not close on Escape.
  if (!baseReady && await isUsableBaseState(page, baseUrl)) baseReady = true;
  if (!baseReady) baseReady = await recoverRootFromHistory(page, baseUrl, options.expectedRootFingerprint);
  if (!baseReady) {
    try {
      await navigateAndWait(page, baseUrl, { timeout: 50_000, shellWaitMs: 50_000, settleMs: 700 });
      baseReady = await isUsableBaseState(page, baseUrl);
    } catch {
      baseReady = await recoverRootFromHistory(page, baseUrl, options.expectedRootFingerprint);
    }
  }
  if (!baseReady) return false;
  for (const action of path) {
    const result = await clickSafeAction(page, action);
    if (!result.clicked || result.popup) {
      if (result.popup) await result.popup.close().catch(() => {});
      return false;
    }
  }
  return true;
}

async function recoverRootFromHistory(page, baseUrl, expectedFingerprint) {
  const baseOrigin = safeOrigin(baseUrl);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await isExpectedRootState(page, baseUrl, expectedFingerprint) || await isUsableBaseState(page, baseUrl)) return true;
    const response = await page.goBack({ waitUntil: "commit", timeout: 12_000 }).catch(() => null);
    if (!response && page.url() === "about:blank") return false;
    await waitForPageReady(page, { timeout: 15_000, settleMs: 700 });
    if (baseOrigin && safeOrigin(page.url()) !== baseOrigin) return false;
  }
  return await isExpectedRootState(page, baseUrl, expectedFingerprint) || await isUsableBaseState(page, baseUrl);
}

async function isUsableBaseState(page, baseUrl) {
  if (comparableUrl(page.url()) !== comparableUrl(baseUrl)) return false;
  if (await detectPageAccessFailure(page)) return false;
  return page.evaluate(() => Boolean(document.body && document.body.innerText.trim())).catch(() => false);
}

async function isExpectedRootState(page, baseUrl, expectedFingerprint) {
  if (!expectedFingerprint || comparableUrl(page.url()) !== comparableUrl(baseUrl)) return false;
  try {
    return (await captureApplicationState(page)).fingerprint === expectedFingerprint;
  } catch {
    return false;
  }
}

function comparableUrl(value) {
  try {
    const url = new URL(value);
    url.hash = /^#(?:!\/|\/)/.test(url.hash) ? url.hash : "";
    return url.href.replace(/\/$/, "");
  } catch {
    return String(value || "");
  }
}

function safeOrigin(value) {
  try { return new URL(value).origin; } catch { return null; }
}

export async function captureApplicationState(page) {
  const state = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 2 && rect.height >= 2;
    };
    const text = (selector, limit) => [...document.querySelectorAll(selector)].filter(visible).map((element) => (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, limit);
    return {
      url: location.href,
      title: document.title,
      headings: text("h1,h2,h3", 20),
      dialogs: text('[role="dialog"],dialog[open]', 10),
      selectedTabs: text('[role="tab"][aria-selected="true"]', 10),
      expanded: text('[aria-expanded="true"]', 20),
      body: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4_000)
    };
  });
  const fingerprint = createHash("sha1").update(JSON.stringify(state)).digest("hex").slice(0, 12);
  return { ...state, fingerprint };
}

export function isUnsafeActionLabel(label) {
  return UNSAFE_ACTION.test(String(label || ""));
}

export function isExcludedActionLabel(label, exclusions = []) {
  const normalized = String(label || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return Boolean(normalized) && exclusions.some((item) => String(item || "").replace(/\s+/g, " ").trim().toLocaleLowerCase() === normalized);
}

function actionSignature(action) {
  return createHash("sha1").update([action.frameIndex, action.frameUrl, action.tag, action.role, action.label, action.path].join("|")).digest("hex").slice(0, 16);
}

function resolveFrame(page, action) {
  const frames = page.frames();
  return frames[action.frameIndex]?.url() === action.frameUrl
    ? frames[action.frameIndex]
    : frames.find((frame) => frame.url() === action.frameUrl) || frames[action.frameIndex];
}

function deduplicate(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    if (seen.has(action.signature)) return false;
    seen.add(action.signature);
    return true;
  });
}
