import { isPageVisiblyReady, waitForPageReady } from "./readiness.js";

const OBSTRUCTION_SELECTOR = '[role="dialog"],[aria-modal="true"],dialog[open],.modal.show,.modal[open],[popover]:popover-open';
const selectedContextByPage = new WeakMap();

export async function waitForPostLoginObstruction(page, timeout = 300_000) {
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
      const context = await resolveContextChooserIfPresent(page, config, onEvent);
      if (context.handled) {
        contextSelected = true;
        continue;
      }
    }

    const obstruction = await findSafeCloseControl(page);
    if (obstruction?.requiresUser) throw postLoginError(`User action required: ${obstruction.reason}`);
    if (!obstruction) break;
    const close = page.frames()[obstruction.frameIndex]?.locator(`[data-a11y-post-login-key="${obstruction.key}"]`).first();
    if (!close) break;
    onEvent({ type: "post-login", message: `Closing a non-security obstruction using “${obstruction.label}”.`, url: page.url() });
    await close.click({ timeout: 4_000 });
    await page.waitForTimeout(500);
    await waitForPageReady(page, { timeout: 15_000, settleMs: 500 });
  }
}

// This intentionally handles only a visible context chooser. It is safe to call
// at crawl checkpoints because normal dialogs and ordinary page inputs are left
// untouched when a domain/tenant/workspace-style chooser is not present.
export async function resolveContextChooserIfPresent(page, config, onEvent = () => {}, options = {}) {
  const desiredContext = String(config.login?.postLoginValue || "").trim().slice(0, 256);
  const alreadySelected = Boolean(desiredContext) && selectedContextByPage.get(page) === desiredContext;
  let contextInput = await findContextInput(page);
  const appearanceTimeout = alreadySelected ? 0 : Math.max(0, Number(options.appearanceTimeout || 0));
  const appearanceDeadline = Date.now() + appearanceTimeout;
  while (!contextInput && Date.now() < appearanceDeadline) {
    await page.waitForTimeout(Math.min(150, Math.max(1, appearanceDeadline - Date.now()))).catch(() => {});
    contextInput = await findContextInput(page);
  }
  if (!contextInput) return { handled: false, alreadySelected };

  if (!desiredContext) throw postLoginError(`Post-login setup requires a ${contextInput.kind}. Enter it in the “Domain / tenant / workspace” field and retry.`);

  const frame = page.frames()[contextInput.frameIndex];
  const input = frame?.locator(`[data-a11y-post-login-key="${contextInput.key}"]`).first();
  if (!input || !(await input.isVisible({ timeout: 500 }).catch(() => false))) return { handled: false };

  onEvent({ type: "post-login", message: `A ${contextInput.kind} chooser appeared; selecting the supplied value.`, url: page.url() });
  await input.fill(desiredContext);
  const option = await waitForExactOption(page, desiredContext, 10_000);
  if (!option) throw postLoginError(`The post-login ${contextInput.kind} chooser did not show an exact match for the supplied value.`);
  const locator = page.frames()[option.frameIndex]?.locator(`[data-a11y-post-login-key="${option.key}"]`).first();
  if (!locator) return { handled: false };
  await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
  await locator.click({ timeout: 5_000 });
  selectedContextByPage.set(page, desiredContext);
  onEvent({ type: "post-login-context-selected", message: `Selected “${desiredContext}” in the ${contextInput.kind} chooser.`, url: page.url() });
  await page.waitForTimeout(250);
  const ready = await waitForPageReady(page, { timeout: 300_000, shellWaitMs: 300_000, settleMs: 700 });
  if (!ready) throw postLoginError(`The application did not finish loading after the ${contextInput.kind} selection.`);
  return { handled: true, kind: contextInput.kind, value: desiredContext };
}

async function findContextInput(page) {
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const result = await frames[frameIndex].evaluate(({ frameIndex }) => {
      const visible = (element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 3 && rect.height >= 3; };
      const containers = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],.modal.show,.modal[open],[popover]:popover-open')].filter(visible);
      const candidates = containers.flatMap((container) => [...container.querySelectorAll('input:not([type="password"]):not([type="hidden"]),textarea,[role="combobox"],[contenteditable="true"]')]);
      for (let index = 0; index < candidates.length; index += 1) {
        const element = candidates[index];
        if (!visible(element)) continue;
        const labels = element.labels ? [...element.labels].map((label) => label.textContent).join(" ") : "";
        const semantic = [element.getAttribute("placeholder"), element.getAttribute("aria-label"), element.getAttribute("name"), element.id, labels, element.closest("label")?.textContent].filter(Boolean).join(" ");
        const match = semantic.match(/\b(domains?|tenants?|workspaces?|organizations?|compan(?:y|ies)|clients?)\b/i);
        if (!match) continue;
        const key = `post-login-input-f${frameIndex}-${index}`;
        element.setAttribute("data-a11y-post-login-key", key);
        const matchedKind = match[1].toLowerCase();
        const kind = matchedKind === "companies" ? "company" : matchedKind.replace(/s$/, "");
        return { frameIndex, key, kind };
      }
      return null;
    }, { frameIndex }).catch(() => null);
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

async function findSafeCloseControl(page) {
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const result = await frames[frameIndex].evaluate(({ frameIndex }) => {
      const visible = (element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 3 && rect.height >= 3; };
      const containers = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],.modal.show,.modal[open]')].filter(visible);
      for (const container of containers) {
        const text = (container.textContent || "").replace(/\s+/g, " ").trim();
        if (/captcha|verification code|one[- ]time|\botp\b|mfa|authenticator|approve sign|passkey|security key|biometric|consent|permission/i.test(text)) return { requiresUser: true, reason: "a security or consent dialog is blocking the application" };
        const control = [...container.querySelectorAll('button,[role="button"],[aria-label],[title]')].filter(visible).find((element) => {
          const label = (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "").replace(/\s+/g, " ").trim();
          return /^(?:close|dismiss|not now|skip|cancel|x|×)$/i.test(label);
        });
        if (!control) continue;
        const key = `post-login-close-f${frameIndex}`;
        control.setAttribute("data-a11y-post-login-key", key);
        const label = (control.getAttribute("aria-label") || control.getAttribute("title") || control.textContent || "Close").replace(/\s+/g, " ").trim();
        return { frameIndex, key, label };
      }
      return null;
    }, { frameIndex }).catch(() => null);
    if (result) return result;
  }
  return null;
}

function postLoginError(message) {
  const error = new Error(message);
  error.code = "POST_LOGIN_INPUT_REQUIRED";
  return error;
}
