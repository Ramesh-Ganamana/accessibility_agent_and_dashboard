import { createHash, randomBytes } from "node:crypto";
import { detectPageAccessFailure, navigateAndWait, waitForPageReady } from "../browser/readiness.js";
import { documentType } from "./documents.js";
import { prepareActionExclusions, isActionExcluded, guardedClick, excludedControlInOpenDialog } from "../browser/action-exclusions.js";

// These exclusions apply to every profile, not just known banking domains.
// Label/URL guards reduce risk but cannot prove an arbitrary site's click is
// read-only; consequential journeys still need an approved test environment.
const UNSAFE_ACTION = /\b(delete|remove|destroy|erase|logout|log\s*out|sign\s*out|pay|purchase|buy|sell|transfer|withdraw|redeem|deposit|invest|authorize|authorise|execute\s+(?:order|trade)|place\s+(?:order|trade)|modify\s+order|e[\s-]?sign|checkout|submit|save|create|register|sign\s*up|enroll|join\s+now|new\s+account|open\s+account|add|approve|reject|confirm|send|publish|upload|unsubscribe|disable|deactivate|terminate|cancel\s+(?:account|subscription|order)|reset|clear\s+all|archive|unarchive|revoke|decline|close\s+(?:my\s+)?account|mark\s+(?:all\s+)?(?:as\s+)?(?:read|unread|done|complete|paid)|duplicate|clone|invite|unfollow|discard|unassign|resend|rerun|regenerate|accept\s+(?:invite|invitation|offer|request|terms)|leave\s+(?:group|team|organi[sz]ation|workspace|channel|meeting)|end\s+(?:session|meeting|call)|(?:order|book|reserve)\s+now|start\s+(?:(?:free\s+)?trial|subscription)|generate\s+(?:report|invoice|key|token)|rotate\s+(?:key|secret|token)|move\s+to\s+(?:trash|bin|archive)|empty\s+(?:trash|bin)|rollback|roll\s+back|restart|shut\s*down|reboot|purge|wipe)\b/i;
// Short imperative button labels that are usually actions, but are also common
// navigation words ("Leave" in an HR menu). They only block non-link controls.
const UNSAFE_CONTROL_START = /^(?:start|stop|run|retry|restore|enable|activate|lock|unlock|pin|unpin|star|unstar|bookmark|follow|like|unlike|vote|rate|block|unblock|mute|unmute|assign|claim|generate|book|reserve|leave|end|download|move|copy|accept|dismiss|deploy|merge|release|print)\b/i;
// \b is ASCII-only in JavaScript, so non-English labels need Unicode-aware
// boundaries. These are the common destructive, payment and logout verbs.
const INTERNATIONAL_TERMS = [
  // Spanish
  "eliminar", "borrar", "quitar", "pagar", "comprar", "vender", "transferir", "enviar", "guardar", "confirmar", "aprobar", "rechazar", "cerrar\\s+sesión", "registrarse", "suscribirse", "darse\\s+de\\s+baja",
  // French
  "supprimer", "effacer", "retirer", "payer", "acheter", "vendre", "virement", "envoyer", "enregistrer", "valider", "confirmer", "approuver", "rejeter", "déconnexion", "se\\s+déconnecter", "s['’]inscrire", "se\\s+désabonner", "désactiver",
  // German
  "löschen", "entfernen", "bezahlen", "kaufen", "verkaufen", "überweisen", "senden", "absenden", "speichern", "bestätigen", "genehmigen", "ablehnen", "abmelden", "ausloggen", "registrieren", "kündigen", "deaktivieren",
  // Portuguese
  "excluir", "apagar", "remover", "salvar", "aprovar", "rejeitar", "cadastrar",
  // Italian
  "elimina", "eliminare", "cancella", "rimuovi", "paga", "acquista", "vendi", "trasferisci", "invia", "salva", "conferma", "approva", "rifiuta", "disconnetti", "registrati",
  // Dutch
  "verwijderen", "betalen", "kopen", "verkopen", "overboeken", "verzenden", "versturen", "opslaan", "bevestigen", "goedkeuren", "afwijzen", "uitloggen", "afmelden",
  // Hindi
  "हटाएं", "हटाएँ", "हटाओ", "मिटाएं", "मिटाएँ", "भुगतान", "खरीदें", "बेचें", "भेजें", "सहेजें", "पुष्टि", "लॉग\\s*आउट", "साइन\\s*आउट", "रद्द"
];
const UNSAFE_ACTION_INTERNATIONAL = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])(?:${INTERNATIONAL_TERMS.join("|")})(?![\\p{L}\\p{N}\\p{M}])`, "iu");
const MUTATING_ROLE = /^(checkbox|radio|switch|option|slider|spinbutton)$/i;
// Rotating or ticking content changes on its own. It must not make an unchanged
// application state look new, or force a reload before every click.
export const VOLATILE_CONTENT_SELECTOR = '[aria-live],[role="marquee"],[role="timer"],[role="log"],[role="status"],[role="alert"],time,marquee,[class*="carousel" i],[class*="slider" i],[class*="swiper" i],[class*="slick" i],[class*="marquee" i],[class*="ticker" i],[class*="countdown" i],[class*="clock" i]';

export async function inventorySafeActions(page, options = {}) {
  await prepareActionExclusions(page, options);
  const attempts = Math.max(1, Number(options.attempts || 4));
  let actions = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (page.isClosed?.()) break;
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
  // A fresh key prefix per inventory means a stale marker left on an element by
  // an earlier pass can never be mistaken for a newly approved control.
  const nonce = randomBytes(3).toString("hex");
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    actions.push(...await inventoryFrame(frames[frameIndex], frameIndex, { nonce }));
  }
  return deduplicate(actions);
}

async function inventoryFrame(frame, frameIndex, { nonce = "", onlyKey = "" } = {}) {
  const entries = await frame.evaluate(({ frameIndex, nonce, onlyKey }) => {
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
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      roots[index].querySelectorAll?.("*").forEach((element) => { if (element.shadowRoot) roots.push(element.shadowRoot); });
    }
    if (onlyKey) {
      for (const root of roots) {
        const match = root.querySelector?.(`[data-clarity-action-key="${CSS.escape(onlyKey)}"]`);
        if (match) { candidates.push(match); break; }
      }
    } else {
      for (const root of roots) {
        root.querySelectorAll?.("[data-clarity-action-key]").forEach((element) => element.removeAttribute("data-clarity-action-key"));
        root.querySelectorAll?.(selector).forEach((element) => candidates.push(element));
      }
    }
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
    // Header/navigation/footer controls repeat on every page of a site. The
    // crawler reuses their interaction states instead of re-scanning them.
    const region = (element) => {
      const shared = element.closest('header,nav,footer,[role="banner"],[role="navigation"],[role="contentinfo"]');
      if (!shared || shared.closest('main,[role="main"],[role="dialog"],dialog,[aria-modal="true"]')) return "main";
      return "global";
    };
    return [...new Set(candidates)].flatMap((element, index) => {
      const tag = element.localName;
      if (!isVisible(element) || !isClickable(element) || element.matches(":disabled,[aria-disabled='true']")) return [];
      // Checked after the cheap filters. A child of a listed card or link is
      // excluded together with it.
      if (window.__clarityActionExclusions?.matches(element)) return [];
      if (element.isContentEditable || element.closest("[contenteditable='true']")) return [];
      const owningControl = element.closest('button,input,select,textarea,option,label,[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[role="slider"],[role="spinbutton"]');
      if (owningControl && owningControl !== element &&
        (owningControl.localName !== "button" || owningControl.form && /^(submit|reset)$/.test(owningControl.type) || owningControl.matches(':disabled,[aria-disabled="true"]'))) return [];
      const role = element.getAttribute("role") || (tag === "button" ? "button" : tag === "a" || tag === "area" ? "link" : "clickable");
      const type = String(element.type || element.getAttribute("type") || "").toLowerCase();
      const label = (window.__clarityActionExclusions?.label(element) || element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
      if (!label || element.form && (type === "submit" || type === "reset") || element.closest("form") && tag === "input") return [];
      if ((tag === "div" || tag === "span") && !element.hasAttribute("onclick") && !element.hasAttribute("role") && element.tabIndex < 0) {
        const parent = element.parentElement;
        const parentLabel = (parent?.getAttribute("aria-label") || parent?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (parent && getComputedStyle(parent).cursor === "pointer" && parentLabel === label) return [];
      }
      const key = onlyKey || `clarity-${nonce}-${frameIndex}-${index}`;
      element.setAttribute("data-clarity-action-key", key);
      return [{
        key,
        frameIndex,
        frameUrl: location.href,
        tag,
        role,
        type,
        label,
        href: element.href || "",
        opensTab: Boolean(element.target && !["_self", "_top", "_parent"].includes(element.target)),
        path: domPath(element),
        region: region(element),
        inForm: Boolean(element.closest("form")),
        hasPopup: element.getAttribute("aria-haspopup") || "",
        expanded: element.getAttribute("aria-expanded")
      }];
    });
  }, { frameIndex, nonce, onlyKey }).catch(() => []);

  const actions = [];
  for (const entry of entries) {
    const labelUnsafe = navigatesAway(entry) ? isUnsafeActionLabel(entry.label) : isUnsafeControlLabel(entry.label);
    // Document links download files; the document checker handles them separately.
    const unsafe = labelUnsafe || isUnsafeNavigationUrl(entry.href) || Boolean(entry.href && documentType(entry.href)) || MUTATING_ROLE.test(entry.role) || entry.inForm && /^(button|clickable)$/.test(entry.role) && !/\b(next|previous|continue|back|open|view|details|menu|tab)\b/i.test(entry.label);
    if (unsafe) continue;
    actions.push({ ...entry, signature: actionSignature(entry) });
  }
  return actions;
}

// A real link to another document is navigation; a "#" link behaves like a button.
function navigatesAway(entry) {
  if (!entry.href || !/^(a|area)$/.test(entry.tag) && entry.role !== "link") return false;
  try {
    const target = new URL(entry.href);
    const current = new URL(entry.frameUrl);
    if (!["http:", "https:"].includes(target.protocol)) return false;
    return `${target.origin}${target.pathname}${target.search}` !== `${current.origin}${current.pathname}${current.search}` || /^#(?:!\/|\/)/.test(target.hash);
  } catch {
    return false;
  }
}

export async function clickSafeAction(page, expectedAction, options = {}) {
  if (page.isClosed?.()) return { clicked: false, reason: "page-closed" };
  await prepareActionExclusions(page, options);
  let action = null;
  // Fast path: re-check only the element tagged by the inventory that offered it.
  // Its label, path and safety are recomputed; any mismatch falls back to a full scan.
  if (expectedAction.key) {
    const frame = resolveFrame(page, expectedAction);
    const frameIndex = frame ? page.frames().indexOf(frame) : -1;
    if (frameIndex >= 0) {
      const [candidate] = await inventoryFrame(frame, frameIndex, { onlyKey: expectedAction.key });
      if (candidate?.signature === expectedAction.signature) action = candidate;
    }
  }
  if (!action) {
    const currentActions = await inventorySafeActions(page, { attempts: 2 });
    action = currentActions.find((candidate) => candidate.signature === expectedAction.signature);
  }
  if (!action) return { clicked: false, reason: page.isClosed?.() ? "page-closed" : "control-not-found" };
  const frame = resolveFrame(page, action);
  if (!frame) return { clicked: false, reason: "frame-not-found" };
  const locator = frame.locator(`[data-clarity-action-key="${action.key}"]`).first();
  if (await isActionExcluded(locator)) return { clicked: false, reason: "user-excluded" };
  let popup = null;
  const capturePopup = (opened) => { popup = opened; };
  page.on("popup", capturePopup);
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 3_000 });
    await guardedClick(locator, { timeout: 5_000 });
    await page.waitForTimeout(150);
    const readyTimeout = Number(options.readyTimeout ?? 50_000);
    const ready = popup
      ? await waitForPageReady(popup, { timeout: readyTimeout, shellWaitMs: readyTimeout, settleMs: 700 })
      : await waitForPageReady(page, { timeout: readyTimeout, shellWaitMs: readyTimeout, settleMs: 700 });
    if (!ready || page.isClosed?.()) {
      if (popup) await popup.close().catch(() => {});
      return { clicked: false, action, popup: null, reason: page.isClosed?.() ? "page-closed" : "page-readiness-timeout" };
    }
    return { clicked: true, action, popup };
  } catch (error) {
    return { clicked: false, action, reason: page.isClosed?.() ? "page-closed" : error.message };
  } finally {
    page.off("popup", capturePopup);
  }
}

export async function restoreActionPath(page, baseUrl, path, options = {}) {
  // A closed tab would otherwise walk history, reload and replay for ~110 s.
  if (page.isClosed?.()) return false;
  const rootIsAlreadyOpen = await isExpectedRootState(page, baseUrl, options.expectedRootFingerprint);
  // Escape dismisses a dialog the way its close control does. While an open
  // dialog holds a Do not click control, the page is reloaded instead; the
  // dialog would otherwise stay over the controls of the restored state.
  const dialogKept = !rootIsAlreadyOpen && await excludedControlInOpenDialog(page);
  if (!rootIsAlreadyOpen && !dialogKept) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
  }
  if (page.isClosed?.()) return false;
  let baseReady = rootIsAlreadyOpen || await isExpectedRootState(page, baseUrl, options.expectedRootFingerprint);
  // Dropdowns, accordions, and harmless panels can change the fingerprint while
  // leaving the original navigation controls usable. Do not reload a protected
  // SPA route merely because that presentation state did not close on Escape.
  if (!baseReady && !dialogKept && await isUsableBaseState(page, baseUrl)) baseReady = true;
  if (!baseReady && !dialogKept) baseReady = await recoverRootFromHistory(page, baseUrl, options.expectedRootFingerprint);
  if (page.isClosed?.()) return false;
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
    if (page.isClosed?.()) return false;
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

export function comparableUrl(value) {
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
  const state = await page.evaluate((volatileSelector) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 2 && rect.height >= 2;
    };
    const stable = (element) => !element.closest(volatileSelector);
    const text = (selector, limit, filter = () => true) => [...document.querySelectorAll(selector)].filter(visible).filter(filter).map((element) => (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, limit);
    // Remove carousel, ticker, clock and live-region text plus digits so content
    // that changes on its own does not create a different application state.
    let body = document.body?.innerText || "";
    const fullLength = body.length;
    for (const node of document.querySelectorAll(volatileSelector)) {
      const value = node.innerText || "";
      if (value.trim() && value.length <= Math.max(200, fullLength * 0.4)) body = body.replace(value, " ");
    }
    return {
      url: location.href,
      title: document.title.replace(/\d+/g, "#"),
      headings: text("h1,h2,h3", 20, stable),
      dialogs: text('[role="dialog"],dialog[open]', 10),
      selectedTabs: text('[role="tab"][aria-selected="true"]', 10, stable),
      expanded: text('[aria-expanded="true"]', 20, stable),
      body: body.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 4_000)
    };
  }, VOLATILE_CONTENT_SELECTOR);
  const fingerprint = createHash("sha1").update(JSON.stringify(state)).digest("hex").slice(0, 12);
  return { ...state, fingerprint };
}

export function isUnsafeActionLabel(label) {
  const value = String(label || "");
  return UNSAFE_ACTION.test(value) || UNSAFE_ACTION_INTERNATIONAL.test(value);
}

// Buttons and other non-link controls also reject short imperative labels.
export function isUnsafeControlLabel(label) {
  const value = String(label || "").replace(/\s+/g, " ").trim();
  return isUnsafeActionLabel(value) || (value.split(" ").length <= 5 && UNSAFE_CONTROL_START.test(value));
}

export function isUnsafeNavigationUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return true;
    const path = decodeURIComponent(`${url.pathname} ${url.hash}`).replace(/[-_/]+/g, " ");
    const actions = [...url.searchParams].filter(([key]) => /^(?:action|operation|command|intent|do)$/i.test(key)).map(([, item]) => item);
    return isUnsafeActionLabel([path, ...actions].join(" "));
  } catch {
    return true;
  }
}

// Same text rule as the in-page policy: the whole entry, or the entry as whole
// words inside a control-sized label ("Pay" matches "Pay now", not "Payroll").
// Attributes, selectors and URLs are checked by the in-page policy.
export function isExcludedActionLabel(label, exclusions = []) {
  const normalize = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const normalized = normalize(label);
  if (!normalized) return false;
  return exclusions.some((item) => {
    const entry = normalize(item);
    if (!entry) return false;
    // Also equal when only the spacing differs ("KaiserPermanente" in raw text).
    if (entry === normalized || entry.replace(/\s+/g, "") === normalized.replace(/\s+/g, "")) return true;
    return normalized.length <= 300 && new RegExp(`(?<![\\p{L}\\p{N}])${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(normalized);
  });
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
