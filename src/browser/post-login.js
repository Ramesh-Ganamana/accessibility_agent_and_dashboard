import { isPageVisiblyReady, waitForPageReady } from "./readiness.js";
import { resolveBlockingObstruction } from "./blockers.js";
import { assertActionAllowed, guardedClick } from "./action-exclusions.js";

const OBSTRUCTION_SELECTOR = '[role="dialog"],[aria-modal="true"],dialog[open],.modal.show,.modal[open],[popover]:popover-open';
const selectedContextByPage = new WeakMap();
// Once a crawl checkpoint has waited and seen no chooser, later checkpoints do
// not wait again unless the application has just re-authenticated.
const chooserAbsentByPage = new WeakMap();

export async function waitForPostLoginObstruction(page, timeout = 60_000) {
  const deadline = Date.now() + Math.max(0, timeout);
  let readySince = null;
  do {
    for (const frame of page.frames()) {
      const visible = await frame.evaluate((selector) => [...document.querySelectorAll(selector)].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 3 && rect.height >= 3;
      }), OBSTRUCTION_SELECTOR).catch(() => false);
      if (visible) return true;
    }
    if (await isPageVisiblyReady(page)) {
      readySince ||= Date.now();
      if (Date.now() - readySince >= 2_500) return false;
    } else {
      readySince = null;
    }
    if (Date.now() < deadline) await page.waitForTimeout(150);
  } while (Date.now() < deadline);
  return false;
}

export async function resolvePostLoginObstructions(page, config, onEvent = () => {}) {
  let contextSelected = false;
  await waitForPageReady(page, { timeout: 30_000, settleMs: 700 });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!contextSelected) {
      const context = await resolveContextChooserIfPresent(page, config, onEvent, { phase: "post-login" });
      if (context.handled) {
        contextSelected = true;
        continue;
      }
    }

    const obstruction = await resolveBlockingObstruction(page, { onEvent });
    if (!obstruction.detected) break;
    if (!obstruction.handled) throw postLoginError(`User action required: ${obstruction.reason}`);
  }
}

// This intentionally handles only a visible context chooser. At crawl
// checkpoints ("crawl" phase) it acts only on a single-field picker dialog and
// only when a value was supplied, so "Add client" or "Contact us" dialogs with a
// Company field are never typed into and never abort the crawl.
export async function resolveContextChooserIfPresent(page, config, onEvent = () => {}, options = {}) {
  const phase = options.phase === "post-login" ? "post-login" : "crawl";
  const desiredContext = String(config.login?.postLoginValue || "").trim().slice(0, 256);
  if (phase === "crawl" && !desiredContext) return { handled: false, alreadySelected: false };
  const alreadySelected = Boolean(desiredContext) && selectedContextByPage.get(page) === desiredContext;
  const strict = phase === "crawl";
  let contextInput = await findContextInput(page, strict);
  const skipWait = alreadySelected || (phase === "crawl" && chooserAbsentByPage.get(page) && !options.afterAuthentication);
  const appearanceTimeout = skipWait ? 0 : Math.max(0, Number(options.appearanceTimeout || 0));
  const appearanceDeadline = Date.now() + appearanceTimeout;
  while (!contextInput && Date.now() < appearanceDeadline) {
    await page.waitForTimeout(Math.min(150, Math.max(1, appearanceDeadline - Date.now()))).catch(() => {});
    contextInput = await findContextInput(page, strict);
  }
  if (!contextInput) {
    if (appearanceTimeout > 0) chooserAbsentByPage.set(page, true);
    return { handled: false, alreadySelected };
  }
  chooserAbsentByPage.delete(page);

  if (!desiredContext) throw postLoginError(`Post-login setup requires a ${contextInput.kind}. Enter it in the “Domain / tenant / workspace” field and retry.`);

  const frame = page.frames()[contextInput.frameIndex];
  const input = frame?.locator(`[data-a11y-post-login-key="${contextInput.key}"]`).first();
  if (!input || !(await input.isVisible({ timeout: 500 }).catch(() => false))) return { handled: false };

  onEvent({ type: "post-login", message: `A ${contextInput.kind} chooser appeared; selecting the supplied value.`, url: page.url() });
  await assertActionAllowed(input);
  await input.fill(desiredContext);
  const option = await waitForExactOption(page, desiredContext, 10_000);
  if (!option) throw postLoginError(`The post-login ${contextInput.kind} chooser did not show an exact match for the supplied value.`);
  const locator = page.frames()[option.frameIndex]?.locator(`[data-a11y-post-login-key="${option.key}"]`).first();
  if (!locator) return { handled: false };
  await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
  await guardedClick(locator, { timeout: 5_000 });
  selectedContextByPage.set(page, desiredContext);
  onEvent({ type: "post-login-context-selected", message: `Selected “${desiredContext}” in the ${contextInput.kind} chooser.`, url: page.url() });
  await page.waitForTimeout(250);
  const loadWait = Number.isFinite(Number(config.appShellWaitMs)) ? Math.max(30_000, Number(config.appShellWaitMs)) : 300_000;
  const ready = await waitForPageReady(page, { timeout: loadWait, shellWaitMs: loadWait, settleMs: 700 });
  if (!ready) throw postLoginError(`The application did not finish loading after the ${contextInput.kind} selection.`);
  return { handled: true, kind: contextInput.kind, value: desiredContext };
}

async function findContextInput(page, strict = false) {
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const result = await frames[frameIndex].evaluate(({ frameIndex, strict }) => {
      const visible = (element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 3 && rect.height >= 3; };
      const containers = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],.modal.show,.modal[open],[popover]:popover-open')].filter(visible);
      let index = 0;
      for (const container of containers) {
        const fields = [...container.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]),textarea,select,[role="combobox"],[contenteditable="true"]')].filter(visible);
        // A chooser is a picker with one field. Multi-field dialogs are forms.
        if (fields.length !== 1) { index += fields.length; continue; }
        const element = fields[0];
        index += 1;
        if (element.matches('textarea,select,input[type="password"]')) continue;
        const labels = element.labels ? [...element.labels].map((label) => label.textContent).join(" ") : "";
        const semantic = [element.getAttribute("placeholder"), element.getAttribute("aria-label"), element.getAttribute("name"), element.id, labels, element.closest("label")?.textContent].filter(Boolean).join(" ");
        const match = semantic.match(/\b(domains?|tenants?|workspaces?|organizations?|compan(?:y|ies)|clients?)\b/i);
        if (!match) continue;
        if (strict) {
          const framing = [container.getAttribute("aria-label"), ...[...container.querySelectorAll('h1,h2,h3,[role="heading"],legend')].map((node) => node.textContent)].filter(Boolean).join(" ");
          const searchLike = element.type === "search" || element.getAttribute("role") === "combobox" || element.hasAttribute("aria-autocomplete") || element.hasAttribute("list") || /^\s*(search|find|filter)\b/i.test(element.getAttribute("placeholder") || "");
          if (!searchLike && !/\b(select|choose|switch|pick)\b/i.test(framing)) continue;
        }
        const key = `post-login-input-f${frameIndex}-${index}`;
        element.setAttribute("data-a11y-post-login-key", key);
        const matchedKind = match[1].toLowerCase();
        const kind = matchedKind === "companies" ? "company" : matchedKind.replace(/s$/, "");
        return { frameIndex, key, kind };
      }
      return null;
    }, { frameIndex, strict }).catch(() => null);
    if (result) return result;
  }
  return null;
}

async function waitForExactOption(page, value, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const option = await findExactOption(page, value);
    if (option) return option;
    await page.waitForTimeout(250);
  }
  return null;
}

async function findExactOption(page, value) {
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const option = await frames[frameIndex].evaluate(({ frameIndex, desired }) => {
      const normalized = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
      const visible = (element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 3 && rect.height >= 3; };
      const expected = normalized(desired);
      const surfaces = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],.modal.show,.modal[open],[popover]:popover-open,[role="listbox"],[role="tree"],[role="menu"]')].filter(visible);
      const matches = surfaces.flatMap((surface) => [...surface.querySelectorAll('[role="option"],[role="treeitem"],[role="menuitem"],button,li,div,span')])
        .filter((element) => visible(element) && normalized(element.textContent) === expected)
        .sort((a, b) => {
          const interactive = (element) => Number(/^(BUTTON|A|LI)$/.test(element.tagName) || /^(option|treeitem|menuitem|button)$/.test(element.getAttribute("role") || "") || element.hasAttribute("onclick"));
          const area = (element) => { const rect = element.getBoundingClientRect(); return rect.width * rect.height; };
          return interactive(b) - interactive(a) || area(a) - area(b);
        });
      const element = matches[0];
      if (!element) return null;
      const key = `post-login-option-f${frameIndex}`;
      element.setAttribute("data-a11y-post-login-key", key);
      return { frameIndex, key };
    }, { frameIndex, desired: value }).catch(() => null);
    if (option) return option;
  }
  return null;
}

function postLoginError(message) {
  const error = new Error(message);
  error.code = "POST_LOGIN_INPUT_REQUIRED";
  return error;
}
