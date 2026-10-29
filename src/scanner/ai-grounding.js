import OpenAI from "openai";
import { isExcludedActionLabel, isUnsafeActionLabel, isUnsafeControlLabel, isUnsafeNavigationUrl } from "./actions.js";
import { waitForPageReady } from "../browser/readiness.js";
import { actionExclusionsFor, prepareActionExclusions, guardedClick } from "../browser/action-exclusions.js";
import { randomBytes } from "node:crypto";

const MAX_ELEMENTS = 350;

export async function attemptAiGroundedAction(page, { config, onEvent = () => {}, chooseNumber } = {}) {
  if (!chooseNumber && (!config?.aiEnabled || !config?.openAiApiKey)) return { clicked: false, reason: "ai-disabled" };
  const exclusions = config ? actionExclusionsFor(config, page.url()) : [];
  await prepareActionExclusions(page, { excludeLabels: exclusions });
  const map = await buildNumberedDomMap(page);
  const allowed = map.elements.filter((entry) => entry.actionable && !entry.unsafe && !isExcludedActionLabel(entry.label, exclusions));
  if (!allowed.length) {
    await removeGroundingOverlays(page);
    return { clicked: false, reason: "no-safe-grounded-actions" };
  }

  onEvent({ type: "ai-grounding", message: `Numbered ${map.elements.length} deduplicated visible elements; ${allowed.length} are safe action candidates.`, url: page.url() });
  let decision;
  try {
    // The visible viewport only: a full-page capture of a long authenticated page
    // is slow, costly and sends far more application content than needed.
    const screenshot = await page.screenshot({ type: "jpeg", quality: 68, fullPage: false });
    decision = chooseNumber
      ? await chooseNumber({ map, allowed, screenshot })
      : await chooseGroundedNumber({ map, allowed, screenshot, config });
  } catch (error) {
    onEvent({ type: "ai-error", message: `Numbered-element fallback was unavailable: ${firstLine(error.message)}`, url: page.url() });
    await removeGroundingOverlays(page);
    return { clicked: false, reason: "ai-error" };
  }

  const number = Number(decision?.number || 0);
  const selected = allowed.find((entry) => entry.number === number);
  if (!selected || decision?.action !== "click" || Number(decision?.confidence || 0) < 0.65) {
    await removeGroundingOverlays(page);
    return { clicked: false, reason: "no-valid-selection", decision };
  }

  const beforeUrl = page.url();
  const popupPromise = page.waitForEvent("popup", { timeout: 1_500 }).catch(() => null);
  const clicked = await clickMappedElement(page, selected);
  const popup = clicked ? await popupPromise : null;
  await removeGroundingOverlays(page);
  if (!clicked) return { clicked: false, reason: "mapped-element-detached", decision };
  const ready = await waitForPageReady(popup || page, { timeout: 50_000, shellWaitMs: 50_000, settleMs: 700 });
  if (!ready) {
    if (popup) await popup.close().catch(() => {});
    return { clicked: false, reason: "page-readiness-timeout", decision };
  }
  onEvent({ type: "ai-grounding", message: `AI selected numbered element ${number}: ${selected.label || selected.tag}.`, url: page.url() });
  return {
    clicked: true,
    popup,
    beforeUrl,
    decision,
    action: {
      label: selected.label || `${selected.tag} ${number}`,
      path: selected.path,
      number,
      source: "ai-grounding"
    }
  };
}

export async function buildNumberedDomMap(page) {
  await prepareActionExclusions(page);
  const collected = [];
  const frames = page.frames();
  // A fresh key per map: keys left on elements by an earlier map (for example
  // on a hidden SPA panel) can never make a new pick ambiguous.
  const nonce = randomBytes(3).toString("hex");
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const entries = await frames[frameIndex].evaluate(({ frameIndex, maxElements, nonce }) => {
      document.querySelectorAll("[data-a11y-grounding-overlay]").forEach((node) => node.remove());
      const clearKeys = (root) => {
        root.querySelectorAll?.("[data-a11y-ground-key]").forEach((node) => node.removeAttribute("data-a11y-ground-key"));
        root.querySelectorAll?.("*").forEach((node) => { if (node.shadowRoot) clearKeys(node.shadowRoot); });
      };
      clearKeys(document);
      const tags = new Set(["a", "button", "input", "textarea", "select", "option", "label", "div", "span", "p", "img", "svg", "summary", "details", "li", "nav", "main", "section", "article", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6"]);
      const candidates = [];
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width >= 3 && rect.height >= 3;
      };
      const ownText = (element) => [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(" ");
      const compact = (value, limit = 140) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
      const visit = (root) => {
        for (const element of root.querySelectorAll?.("*") || []) {
          if (candidates.length >= maxElements * 5) break;
          if (element.closest?.("[data-a11y-grounding-overlay]")) continue;
          const tag = element.localName;
          const role = element.getAttribute("role") || "";
          if ((tags.has(tag) || role || element.hasAttribute("onclick") || element.hasAttribute("tabindex")) && visible(element)) candidates.push(element);
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      visit(document);

      const ranked = candidates.map((element) => {
        const rect = element.getBoundingClientRect();
        const tag = element.localName;
        const role = element.getAttribute("role") || "";
        const type = element.type || element.getAttribute("type") || "";
        const control = element.closest('button,input,select,textarea,option,label,[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[role="slider"],[role="spinbutton"]');
        const protectedControl = window.__clarityActionExclusions?.matches(element) || element.isContentEditable || Boolean(element.closest('[contenteditable="true"]'))
          || Boolean(control && (control.localName !== "button" || control.form && /^(submit|reset)$/.test(control.type)))
          || element.matches(':disabled,[aria-disabled="true"]');
        const controlLabel = control ? compact(control.getAttribute("aria-label") || control.textContent) : "";
        const href = element.closest("a[href],area[href]")?.href || "";
        const nativeLabel = element.labels ? [...element.labels].map((label) => label.textContent).join(" ") : "";
        const label = compact(window.__clarityActionExclusions?.label(element) || element.getAttribute("aria-label") || element.getAttribute("title") || nativeLabel || ownText(element) || (["input", "textarea", "select"].includes(tag) ? element.getAttribute("placeholder") : "") || element.textContent);
        const actionable = ["a", "button", "input", "select", "textarea", "summary"].includes(tag) || /^(button|link|menuitem|tab|treeitem|option)$/.test(role) || element.hasAttribute("onclick") || element.tabIndex >= 0 || getComputedStyle(element).cursor === "pointer";
        const semantic = actionable || Boolean(role) || !["div", "span"].includes(tag) || Boolean(ownText(element).trim());
        return {
          element,
          tag,
          role,
          type,
          label,
          actionable,
          protectedControl,
          controlLabel,
          href,
          semantic,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        };
      }).filter((entry) => entry.semantic && (entry.label || entry.actionable || ["img", "svg", "input", "select", "textarea"].includes(entry.tag)));

      ranked.sort((a, b) => Number(b.actionable) - Number(a.actionable) || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
      const seen = new Set();
      const unique = [];
      for (const entry of ranked) {
        const geometry = `${Math.round(entry.rect.x / 3)}:${Math.round(entry.rect.y / 3)}:${Math.round(entry.rect.width / 3)}:${Math.round(entry.rect.height / 3)}`;
        const signature = `${geometry}:${entry.label.toLowerCase()}:${entry.actionable}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        unique.push(entry);
        if (unique.length >= maxElements) break;
      }

      const pathFor = (element) => {
        const parts = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
          let part = current.localName;
          if (current.id) part += `#${CSS.escape(current.id)}`;
          else if (current.parentElement) {
            const peers = [...current.parentElement.children].filter((item) => item.localName === current.localName);
            if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
          }
          parts.unshift(part);
          const root = current.getRootNode();
          current = current.parentElement || (root instanceof ShadowRoot ? root.host : null);
          if (root instanceof ShadowRoot) parts.unshift("::shadow");
        }
        return parts.join(" > ");
      };

      return unique.map((entry, localIndex) => {
        const key = `ground-${nonce}-f${frameIndex}-e${localIndex}`;
        entry.element.setAttribute("data-a11y-ground-key", key);
        return { key, frameIndex, tag: entry.tag, role: entry.role, type: entry.type, label: entry.label, actionable: entry.actionable, protectedControl: entry.protectedControl, controlLabel: entry.controlLabel, href: entry.href, rect: entry.rect, path: pathFor(entry.element) };
      });
    }, { frameIndex, maxElements: MAX_ELEMENTS, nonce }).catch(() => []);
    collected.push(...entries);
  }

  const elements = collected.slice(0, MAX_ELEMENTS).map((entry, index) => {
    const label = scrub(entry.label);
    const labelCheck = entry.href ? isUnsafeActionLabel : isUnsafeControlLabel;
    const unsafe = entry.protectedControl || labelCheck(label) || labelCheck(entry.controlLabel) || isUnsafeNavigationUrl(entry.href)
      || /password|passcode|otp|verification code|captcha|file|reset/i.test(`${entry.type} ${label}`);
    const detectedInteractive = entry.actionable;
    const actionable = detectedInteractive || Boolean(label) || ["img", "svg", "input", "select", "textarea"].includes(entry.tag);
    const { protectedControl, controlLabel, href, ...publicEntry } = entry;
    return { ...publicEntry, number: index + 1, label, detectedInteractive, actionable, unsafe };
  });
  await drawGroundingOverlays(page, elements);
  return { page: { origin: safeOrigin(page.url()), title: scrub(await page.title()).slice(0, 160) }, elements };
}

async function chooseGroundedNumber({ map, allowed, screenshot, config }) {
  const client = new OpenAI({ apiKey: config.openAiApiKey });
  const allowedNumbers = new Set(allowed.map((entry) => entry.number));
  const metadata = map.elements.map(({ key, frameIndex, unsafe, ...entry }) => ({ ...entry, allowed: allowedNumbers.has(entry.number) }));
  const response = await client.responses.create({
    model: config.openAiModel,
    store: false,
    instructions: [
      "You select one numbered element to continue crawling a web application after deterministic navigation has stalled.",
      "Choose only an element where allowed is true and that is likely to reveal a new safe application route, panel, menu, tab, or dialog.",
      "Never choose sign-up, registration, account creation, logout, deletion, payment, purchase, submit/save/send, password reset, file upload, or data-changing actions.",
      "Prefer navigation menus, tabs, expanders, view/details controls, and non-mutating buttons. A non-native div, span, label, text, or image may be selected when the screenshot strongly indicates it is an application control missed by DOM heuristics. Return none when no safe useful action exists."
    ].join(" "),
    input: [{ role: "user", content: [
      { type: "input_text", text: `Visible numbered DOM map: ${JSON.stringify({ page: map.page, elements: metadata })}` },
      { type: "input_image", image_url: `data:image/jpeg;base64,${screenshot.toString("base64")}`, detail: "high" }
    ] }],
    text: { format: { type: "json_schema", name: "numbered_dom_action", strict: true, schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["click", "none"] },
        number: { type: "integer", minimum: 0 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        reason: { type: "string" }
      },
      required: ["action", "number", "confidence", "reason"]
    } } },
    max_output_tokens: 180
  });
  return JSON.parse(response.output_text || "{}");
}

async function drawGroundingOverlays(page, elements) {
  for (const frame of page.frames()) {
    const frameElements = elements.filter((entry) => entry.frameIndex === page.frames().indexOf(frame));
    await frame.evaluate((items) => {
      document.querySelectorAll("[data-a11y-grounding-overlay]").forEach((node) => node.remove());
      const find = (root, key) => {
        const direct = root.querySelector?.(`[data-a11y-ground-key="${CSS.escape(key)}"]`);
        if (direct) return direct;
        for (const element of root.querySelectorAll?.("*") || []) {
          if (element.shadowRoot) {
            const nested = find(element.shadowRoot, key);
            if (nested) return nested;
          }
        }
        return null;
      };
      const layer = document.createElement("div");
      layer.setAttribute("data-a11y-grounding-overlay", "true");
      Object.assign(layer.style, { position: "absolute", left: "0", top: "0", width: `${Math.max(document.documentElement.scrollWidth, innerWidth)}px`, height: `${Math.max(document.documentElement.scrollHeight, innerHeight)}px`, pointerEvents: "none", zIndex: "2147483647" });
      for (const item of items) {
        const target = find(document, item.key);
        if (!target) continue;
        const rect = target.getBoundingClientRect();
        const badge = document.createElement("span");
        badge.textContent = String(item.number);
        Object.assign(badge.style, { position: "absolute", left: `${Math.max(0, rect.left + scrollX)}px`, top: `${Math.max(0, rect.top + scrollY)}px`, minWidth: "18px", height: "18px", padding: "1px 4px", color: "white", background: item.unsafe ? "#6b7280" : item.actionable ? "#d71945" : "#2457d6", border: "1px solid white", borderRadius: "4px", font: "700 11px/14px system-ui", boxShadow: "0 1px 4px rgba(0,0,0,.5)" });
        layer.appendChild(badge);
      }
      document.documentElement.appendChild(layer);
    }, frameElements).catch(() => {});
  }
}

async function clickMappedElement(page, selected) {
  const frame = page.frames()[selected.frameIndex];
  if (!frame) return false;
  // Locator actions check visibility, enabled state, and obstruction. A DOM
  // element.click() would activate controls hidden behind a modal.
  return guardedClick(frame.locator(`[data-a11y-ground-key="${selected.key}"]`), { timeout: 5_000 })
    .then(() => true).catch(() => false);
}

export async function removeGroundingOverlays(page) {
  await Promise.all(page.frames().map((frame) => frame.evaluate(() => {
    document.querySelectorAll("[data-a11y-grounding-overlay]").forEach((node) => node.remove());
  }).catch(() => {})));
}

function scrub(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:\d[ -]*?){6,}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function safeOrigin(value) {
  try { return new URL(value).origin; } catch { return "unknown"; }
}

function firstLine(value) {
  return String(value || "Unknown error").split(/\r?\n/, 1)[0];
}
