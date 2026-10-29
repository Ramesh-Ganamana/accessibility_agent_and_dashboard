import { createHash } from "node:crypto";
import { waitForPageReady } from "./readiness.js";
import { prepareActionExclusions, isActionExcluded, guardedClick, excludedControlInOpenDialog } from "./action-exclusions.js";

const BLOCKER_SELECTOR = [
  '[aria-modal="true"]',
  'dialog[open]',
  '[role="dialog"]',
  '.modal.show',
  '.modal[open]',
  '[popover]:popover-open',
  '[class*="modal" i]',
  '[class*="dialog" i]',
  '[class*="popup" i]',
  '[class*="overlay" i]'
].join(",");

export async function inspectBlockingObstruction(page) {
  if (page.isClosed?.()) return null;
  const frames = page.frames();
  const found = [];
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const result = await frames[frameIndex].evaluate(({ frameIndex, selector }) => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width >= 3 && rect.height >= 3;
      };
      const viewportArea = Math.max(1, innerWidth * innerHeight);
      const areaRatio = (element) => {
        const rect = element.getBoundingClientRect();
        const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
        const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
        return width * height / viewportArea;
      };
      const roots = [document];
      for (let index = 0; index < roots.length; index += 1) {
        roots[index].querySelectorAll?.("*").forEach((element) => {
          if (element.shadowRoot) roots.push(element.shadowRoot);
        });
      }
      const all = (query) => roots.flatMap((root) => [...(root.querySelectorAll?.(query) || [])]);
      const backdropPresent = all('[class*="backdrop" i],[class*="overlay" i],[data-overlay],[data-backdrop]')
        .some((element) => visible(element) && areaRatio(element) >= .35 && ["fixed", "absolute"].includes(getComputedStyle(element).position));
      const candidates = [...new Set(all(selector))].filter(visible).flatMap((surface) => {
        const style = getComputedStyle(surface);
        const rect = surface.getBoundingClientRect();
        const role = surface.getAttribute("role") || "";
        const semanticModal = surface.getAttribute("aria-modal") === "true" || surface.localName === "dialog" && surface.open || surface.matches?.(".modal.show,.modal[open],[popover]:popover-open");
        const positionedLayer = ["fixed", "absolute"].includes(style.position) && areaRatio(surface) >= .04;
        const bodyLocked = ["hidden", "clip"].includes(getComputedStyle(document.body).overflow) || ["hidden", "clip"].includes(getComputedStyle(document.documentElement).overflow);
        const classHint = /(?:modal|dialog|popup|overlay)/i.test(String(surface.className || ""));
        const blocking = semanticModal || positionedLayer && (backdropPresent || bodyLocked || role === "dialog" || classHint);
        if (!blocking) return [];

        const controls = [];
        const descendants = [];
        const visit = (root) => {
          root.querySelectorAll?.('button,[role="button"],a[href],[aria-label],[title],[data-testid],[data-action]').forEach((element) => descendants.push(element));
          root.querySelectorAll?.("*").forEach((element) => { if (element.shadowRoot) visit(element.shadowRoot); });
        };
        visit(surface);
        for (const element of [...new Set(descendants)]) {
          if (!visible(element) || element.matches(':disabled,[aria-disabled="true"]')) continue;
          if (element.matches('input,textarea,select,[contenteditable="true"]') || element.closest('[contenteditable="true"]')) continue;
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          const accessible = (element.getAttribute("aria-label") || element.getAttribute("title") || text).replace(/\s+/g, " ").trim();
          const metadata = [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-testid"), element.getAttribute("data-action"), element.id, element.className].filter(Boolean).join(" ");
          let priority = -1;
          if (/^(?:close|dismiss|x|×)$/i.test(accessible) || /(?:^|[-_\s])(?:close|dismiss)(?:$|[-_\s])/i.test(metadata)) priority = 0;
          else if (/^cancel$/i.test(accessible)) priority = 1;
          else if (/^skip$/i.test(accessible)) priority = 2;
          else if (/^not now$/i.test(accessible)) priority = 3;
          else if (/^maybe later$/i.test(accessible)) priority = 4;
          if (priority < 0) continue;
          const key = element.__a11yBlockerControlKey ||= `a11y-blocker-f${frameIndex}-${Math.random().toString(36).slice(2)}`;
          element.setAttribute("data-a11y-blocker-key", key);
          controls.push({ key, label: accessible || "Close", priority });
        }

        controls.sort((a, b) => a.priority - b.priority);
        const inputs = allInputs(surface).filter(visible);
        const text = (surface.innerText || surface.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
        const title = surface.querySelector("h1,h2,h3,[role='heading']")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 160)
          || surface.getAttribute("aria-label")?.slice(0, 160)
          || text.slice(0, 160)
          || "Blocking dialog";
        if (!semanticModal && /overlay/i.test(String(surface.className || "")) && !controls.length && !inputs.length && !text) return [];
        return [{
          identity: surface.__a11yBlockerIdentity ||= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
          frameIndex,
          frameUrl: location.href,
          title,
          text,
          controls,
          inputCount: inputs.length,
          securityChallenge: /captcha|verification code|one[- ]time|\botp\b|mfa|authenticator|passkey|security key|biometric/i.test(text),
          coverage: areaRatio(surface),
          zIndex: Number.parseInt(style.zIndex, 10) || 0,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }];
      });
      candidates.sort((a, b) => b.zIndex - a.zIndex || b.coverage - a.coverage);
      return candidates[0] || null;

      function allInputs(surface) {
        const inputs = [...surface.querySelectorAll('input,textarea,select,[contenteditable="true"]')];
        surface.querySelectorAll("*").forEach((element) => {
          if (element.shadowRoot) inputs.push(...element.shadowRoot.querySelectorAll('input,textarea,select,[contenteditable="true"]'));
        });
        return inputs;
      }
    }, { frameIndex, selector: BLOCKER_SELECTOR }).catch(() => null);
    if (result) found.push(result);
  }
  if (!found.length) return null;
  found.sort((a, b) => b.zIndex - a.zIndex || b.coverage - a.coverage);
  const blocker = found[0];
  // Text and geometry can change while a dialog remains open (validation errors,
  // animations, and asynchronous content). Track the actual surface instead.
  blocker.fingerprint = createHash("sha1").update([blocker.frameUrl, blocker.identity].join("|")).digest("hex").slice(0, 16);
  return blocker;
}

export async function resolveBlockingObstruction(page, options = {}) {
  await prepareActionExclusions(page, options);
  const onEvent = options.onEvent || (() => {});
  // A closed page inspects as "no blocker", which would otherwise be recorded as
  // a dialog dismissed by its control or by Escape.
  const closed = { detected: false, handled: false, reason: "page-closed" };
  if (page.isClosed?.()) return closed;
  const blocker = await inspectBlockingObstruction(page);
  if (page.isClosed?.()) return closed;
  if (!blocker) return { detected: false, handled: false };

  const attempted = new Set();
  let excludedControl = false;
  onEvent({
    type: "blocker-detected",
    message: `A blocking dialog or overlay was detected: “${blocker.title}”. Existing input values will not be changed.`,
    url: page.url(),
    blocker: blockerSummary(blocker)
  });

  for (const control of blocker.controls) {
    if (page.isClosed?.()) return closed;
    const attemptKey = `${blocker.fingerprint}|${control.priority}|${control.label}`;
    if (attempted.has(attemptKey)) continue;
    attempted.add(attemptKey);
    const frame = resolveFrame(page, blocker);
    const locator = frame?.locator(`[data-a11y-blocker-key="${control.key}"]`).first();
    if (!locator || !(await locator.isVisible({ timeout: 500 }).catch(() => false))) continue;
    if (await isActionExcluded(locator)) {
      excludedControl = true;
      onEvent({ type: "action-skip", message: "A dialog control was skipped because it matches the Do not click list.", url: page.url() });
      continue;
    }
    onEvent({ type: "blocker-recovery", message: `Trying the safe dismiss control “${control.label}”.`, url: page.url() });
    const clicked = await guardedClick(locator, { timeout: 4_000 }).then(() => true).catch((error) => {
      if (error.code === "USER_EXCLUDED_ACTION") excludedControl = true;
      return false;
    });
    if (page.isClosed?.()) return closed;
    if (!clicked) continue;
    await page.waitForTimeout(350).catch(() => {});
    if (page.isClosed?.()) return closed;
    if (await blockerWasRemoved(page, blocker.fingerprint)) {
      await waitForPageReady(page, { timeout: 15_000, settleMs: 500 });
      onEvent({ type: "blocker-resolved", message: `The blocking dialog was dismissed using “${control.label}”.`, url: page.url() });
      return { detected: true, handled: true, method: "control", control: control.label, blocker: blockerSummary(blocker) };
    }
  }

  // Do not bypass an explicitly excluded dismissal with Escape or replay, also
  // when the listed control was not recognized as a dismiss control.
  if (!excludedControl && await excludedControlInOpenDialog(page)) {
    excludedControl = true;
    onEvent({ type: "action-skip", message: "Escape was not pressed because the open dialog contains a control on the Do not click list.", url: page.url() });
  }
  if (excludedControl) return { detected: true, handled: false, requiresUser: true, reason: "user_excluded_action", blocker: blockerSummary(blocker) };
  onEvent({ type: "blocker-recovery", message: "No safe dismiss control cleared the blocker; trying Escape without changing any input.", url: page.url() });
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(350).catch(() => {});
  if (page.isClosed?.()) return closed;
  if (await blockerWasRemoved(page, blocker.fingerprint)) {
    onEvent({ type: "blocker-resolved", message: "The blocking dialog was dismissed with Escape.", url: page.url() });
    return { detected: true, handled: true, method: "escape", blocker: blockerSummary(blocker) };
  }

  if (typeof options.restore === "function") {
    onEvent({ type: "blocker-recovery", message: "The blocker remained after Escape; restoring the previous safe application state.", url: page.url() });
    const restored = await options.restore().catch(() => false);
    if (page.isClosed?.()) return closed;
    if (restored && await blockerWasRemoved(page, blocker.fingerprint)) {
      onEvent({ type: "blocker-resolved", message: "The previous safe application state was restored.", url: page.url() });
      return { detected: true, handled: true, method: "restore", blocker: blockerSummary(blocker) };
    }
  }

  const reason = blocker.securityChallenge
    ? "security_challenge_requires_user"
    : blocker.inputCount > 0
      ? "required_input_missing"
      : "modal_could_not_be_closed";
  onEvent({
    type: "blocker-user-action-required",
    message: blocker.inputCount > 0
      ? `The blocking dialog “${blocker.title}” requires user input and could not be dismissed safely. No field was changed.`
      : `The blocking dialog “${blocker.title}” could not be dismissed safely.`,
    url: page.url(),
    reason,
    blocker: blockerSummary(blocker)
  });
  return { detected: true, handled: false, requiresUser: true, reason, blocker: blockerSummary(blocker) };
}

async function blockerWasRemoved(page, fingerprint) {
  const current = await inspectBlockingObstruction(page);
  // A page that closed during the inspection is not a dismissed blocker.
  if (page.isClosed?.()) return false;
  return !current || current.fingerprint !== fingerprint;
}

function resolveFrame(page, blocker) {
  const frames = page.frames();
  return frames[blocker.frameIndex]?.url() === blocker.frameUrl
    ? frames[blocker.frameIndex]
    : frames.find((frame) => frame.url() === blocker.frameUrl) || frames[blocker.frameIndex];
}

function blockerSummary(blocker) {
  return {
    fingerprint: blocker.fingerprint,
    title: blocker.title,
    frameUrl: blocker.frameUrl,
    inputCount: blocker.inputCount,
    securityChallenge: blocker.securityChallenge,
    safeDismissControls: blocker.controls.map((control) => control.label)
  };
}
