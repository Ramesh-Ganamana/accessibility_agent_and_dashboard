// Properties that commonly carry a focus indicator. A visible indicator is any
// difference in these between the focused and unfocused states.
const FOCUS_PROPERTIES = [
  "outlineStyle", "outlineWidth", "outlineColor", "outlineOffset", "boxShadow",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "borderTopWidth", "borderBottomWidth", "backgroundColor", "backgroundImage", "color",
  "textDecorationLine", "textDecorationColor", "textDecorationThickness", "filter", "opacity", "transform"
];
// Per page and rule, so one broken template cannot flood the report.
const MAX_FINDINGS_PER_RULE = 15;

// Traverses the page with Tab from the top of the document and reports, as
// needs-review findings: missing visible focus (2.4.7), controls Tab never
// reaches and custom controls that cannot take focus (2.1.1), keyboard traps
// (2.1.2), positive tabindex and large backward focus jumps (2.4.3), and focus
// entirely hidden behind fixed or sticky content (2.4.11).
export async function scanKeyboardFocus(page, pageUrl, maxTabs = 24, options = {}) {
  const findings = [];
  const steps = [];
  const visited = new Map();
  const startUrl = page.url();
  // Start at the top of the document without clicking: a click at a fixed point
  // activates whatever control happens to sit there. Transitions are paused so
  // the focused and unfocused styles can be compared immediately.
  const prepared = await page.evaluate(() => {
    if (!document.body) return false;
    const style = document.createElement("style");
    style.setAttribute("data-a11y-focus-probe", "true");
    style.textContent = "*,*::before,*::after{transition:none!important;animation-play-state:paused!important}";
    (document.head || document.documentElement).appendChild(style);
    document.activeElement?.blur?.();
    const start = document.createElement("span");
    start.tabIndex = -1;
    document.body.prepend(start);
    start.focus({ preventScroll: true });
    start.remove();
    return true;
  }).catch(() => false);
  if (!prepared) return findings;

  let reachedEnd = false;
  let completed = false;
  let trap = null;
  let previousSignature = null;
  let unmoved = 0;
  try {
    for (let index = 0; index < maxTabs; index += 1) {
      await page.keyboard.press("Tab");
      // Focus moved the page somewhere else; later stops would be misattributed.
      if (page.url() !== startUrl) break;
      const state = await page.evaluate(probeFocusedElement, { properties: FOCUS_PROPERTIES }).catch(() => null);

      if (!state) {
        // Focus left the document content (browser chrome or body): the end of
        // the sequence. The next stop should be the first element again.
        if (steps.length) reachedEnd = true;
        previousSignature = null;
        continue;
      }
      if (state.signature === previousSignature) {
        // Tab did not move focus. Twice in a row is a candidate trap; Shift+Tab
        // is tried before recording it.
        unmoved += 1;
        if (unmoved >= 2) {
          await page.keyboard.press("Shift+Tab");
          const back = await page.evaluate(probeFocusedElement, { properties: FOCUS_PROPERTIES, light: true }).catch(() => null);
          trap = { step: state, escapesBackward: Boolean(back && back.signature !== state.signature), reason: "Tab no longer moves focus away from this element." };
          break;
        }
        continue;
      }
      unmoved = 0;
      if (visited.has(state.signature)) {
        const firstIndex = visited.get(state.signature);
        if (firstIndex === 0 && reachedEnd) completed = true;
        else if (!reachedEnd) {
          const cycle = steps.slice(firstIndex);
          // Cycling inside an open modal dialog is correct focus containment.
          if (!cycle.every((step) => step.inModal)) trap = { step: state, cycle, reason: `Focus cycles among ${cycle.length} element(s) without reaching the rest of the page.` };
        }
        break;
      }
      visited.set(state.signature, steps.length);
      steps.push({ ...state, index });
      previousSignature = state.signature;
      if (!state.hasIndicator) {
        findings.push(finding("focus-visible", ["2.4.7"], "serious", "Keyboard focus indicator may not be visible",
          "No visible style change was detected between the focused and unfocused states of this element or its wrappers (outline, shadow, border, background, color, underline or pseudo-element).",
          state, pageUrl, `Observed outline: ${state.computed.outline}; box-shadow: ${state.computed.boxShadow}`, `keyboard-tab-${index + 1}`));
      }
      if (state.obscured) {
        findings.push(finding("focus-obscured", ["2.4.11"], "serious", "Focused element is hidden behind other content",
          "When this element received keyboard focus, every sampled point of it was covered by fixed or sticky content, so a keyboard user cannot see where focus is.",
          state, pageUrl, `Covered by ${state.obscured}.`, `keyboard-tab-${index + 1}`));
      }
      // Refocusing failed (the element vanished or moved focus); stop rather
      // than continue the traversal from an unknown position.
      if (!state.refocused) break;
    }
  } finally {
    await page.evaluate(() => document.querySelector("[data-a11y-focus-probe]")?.remove()).catch(() => {});
  }

  if (trap) {
    findings.push(finding("keyboard-trap", ["2.1.2"], "critical", "Keyboard focus may be trapped",
      `${trap.reason} ${trap.escapesBackward === false ? "Shift+Tab did not move focus either." : trap.escapesBackward ? "Shift+Tab did move focus back, so check whether a forward exit exists." : ""} Confirm whether a documented key (for example Escape) releases focus.`.replace(/\s+/g, " ").trim(),
      trap.step, pageUrl, trap.cycle ? `Cycle: ${trap.cycle.map((step) => step.label || step.tag).slice(0, 6).join(" → ")}` : "Repeated Tab presses kept focus on the same element.", "keyboard-trap"));
  }

  // Backward jumps: focus moving far up the page between consecutive stops,
  // outside a dialog, often means the tab order does not follow the layout.
  let jumps = 0;
  for (let index = 1; index < steps.length && jumps < 3; index += 1) {
    const previous = steps[index - 1];
    const current = steps[index];
    if (!previous.rect || !current.rect || previous.inModal !== current.inModal) continue;
    const threshold = Math.max(240, (current.viewportHeight || 800) * 0.6);
    if (previous.rect.top - current.rect.top > threshold && Math.abs(previous.rect.left - current.rect.left) < (current.viewportWidth || 1200) * 0.6) {
      jumps += 1;
      findings.push(finding("focus-order-jump", ["2.4.3"], "moderate", "Focus order may not follow the visual order",
        `Tab moved focus from “${previous.label || previous.tag}” up the page by ${Math.round(previous.rect.top - current.rect.top)} px to this element. Check that the order preserves meaning and operability.`,
        current, pageUrl, `Previous stop: ${previous.target.join(" >>> ")}`, `keyboard-tab-${current.index + 1}`));
    }
  }

  // Controls that should be keyboard operable are compared with the stops Tab
  // actually reached. This needs a complete traversal to avoid false reports.
  const inventory = await page.evaluate(listKeyboardCandidates, undefined).catch(() => []);
  const reached = new Set(steps.map((step) => step.signature));
  const reachedRadioGroups = new Set(steps.filter((step) => step.radioGroup).map((step) => step.radioGroup));
  const counts = {};
  const add = (rule, ...args) => {
    counts[rule] = (counts[rule] || 0) + 1;
    if (counts[rule] <= MAX_FINDINGS_PER_RULE) findings.push(finding(rule, ...args));
  };
  for (const candidate of inventory) {
    if (candidate.positiveTabindex) {
      add("focus-order-positive-tabindex", ["2.4.3"], "moderate", "Positive tabindex changes the focus order",
        `tabindex="${candidate.tabindexAttribute}" moves this element ahead of the document order, which commonly produces a confusing focus sequence.`,
        candidate, pageUrl, "Prefer tabindex=\"0\" and DOM order that matches the visual order.", "keyboard-inventory");
    }
    if (candidate.kind === "custom-unfocusable") {
      add("keyboard-custom-control", ["2.1.1"], "serious", "Custom control cannot receive keyboard focus",
        `This element behaves like a ${candidate.role || "control"} (${candidate.reason}) but is not focusable, so keyboard users cannot reach or operate it.`,
        candidate, pageUrl, "Use a native control, or add tabindex=\"0\" with keyboard (Enter/Space) handling.", "keyboard-inventory");
    } else if (candidate.kind === "removed") {
      add("keyboard-removed-from-tab-order", ["2.1.1"], "moderate", "Control is removed from the Tab order",
        "tabindex=\"-1\" removes this visible control from sequential keyboard navigation. Confirm another keyboard route exists.",
        candidate, pageUrl, "tabindex=\"-1\" on a visible, enabled control outside a composite widget.", "keyboard-inventory");
    } else if (candidate.kind === "native" && (completed || reachedEnd) && !trap && !reached.has(candidate.signature)
      && !(candidate.radioGroup && reachedRadioGroups.has(candidate.radioGroup))) {
      add("keyboard-unreachable", ["2.1.1"], "serious", "Control was not reached with the Tab key",
        "A full Tab traversal of the page never focused this visible, enabled control.",
        candidate, pageUrl, "Not present in the observed Tab sequence.", "keyboard-inventory");
    }
  }
  if (options.coverage) options.coverage({ stops: steps.length, completed: completed || reachedEnd, trap: Boolean(trap) });
  return findings;
}

function finding(ruleId, wcag, impact, help, description, element, pageUrl, failureSummary, state) {
  return {
    id: `${ruleId}-${simpleHash(`${pageUrl}-${element.signature || element.target?.join(" ")}-${state}`)}`,
    findingType: "needs-review",
    ruleId,
    impact,
    help,
    description,
    helpUrl: `https://www.w3.org/WAI/WCAG22/Understanding/${UNDERSTANDING[wcag[0]] || "keyboard"}.html`,
    tags: ["wcag2a", ...wcag.map((id) => `wcag${id.replaceAll(".", "")}`)],
    wcag,
    target: element.target,
    html: `<${element.tag}>${escapeHtml(element.label || "")}</${element.tag}>`,
    failureSummary,
    pageUrl,
    frameUrl: pageUrl,
    state,
    evidence: null,
    source: "keyboard-traversal"
  };
}

const UNDERSTANDING = {
  "2.1.1": "keyboard", "2.1.2": "no-keyboard-trap", "2.4.3": "focus-order",
  "2.4.7": "focus-visible", "2.4.11": "focus-not-obscured-minimum"
};

// Runs inside the page for the element that currently has focus.
// pathInRoot is repeated in both in-page functions: Playwright serializes each
// function on its own, and building code from strings would break under a
// strict Content Security Policy.
function probeFocusedElement({ properties, light }) {
  const pathInRoot = (element, scope) => {
    const parts = [];
    let current = element;
    while (current && current !== scope && current.nodeType === Node.ELEMENT_NODE) {
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const siblings = [...(current.parentElement?.children || scope.children || [])].filter((item) => item.localName === current.localName);
      const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      parts.unshift(`${current.localName || "*"}${suffix}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const segments = [];
  let root = document;
  let active = document.activeElement;
  while (active) {
    segments.push(pathInRoot(active, root));
    if (active.shadowRoot?.activeElement) {
      root = active.shadowRoot;
      active = active.shadowRoot.activeElement;
    } else break;
  }
  if (!active || active === document.body || active === document.documentElement) return null;
  const signature = `${segments.join(" >>> ")}|${active.getAttribute("href") || ""}`;
  if (light) return { signature };

  const style = getComputedStyle(active);
  const focusVisible = active.matches?.(":focus-visible") ?? false;
  // The element itself and two wrappers (for :focus-within styling).
  const chain = [active, active.parentElement, active.parentElement?.parentElement]
    .filter((element) => element && element !== document.body && element !== document.documentElement);
  const snapshot = () => [
    ...chain.map((element) => { const computed = getComputedStyle(element); return properties.map((name) => computed[name]).join("|"); }),
    ...["::before", "::after"].map((pseudo) => { const computed = getComputedStyle(active, pseudo); return [computed.content, computed.outlineStyle, computed.boxShadow, computed.borderTopColor, computed.backgroundColor, computed.opacity].join("|"); })
  ];
  const focused = snapshot();

  // 2.4.11: sample the centre and four inset points; the element is entirely
  // obscured only if every visible sample hits fixed or sticky content.
  const rect = active.getBoundingClientRect();
  let obscured = null;
  if (rect.width >= 2 && rect.height >= 2) {
    const inset = (size) => Math.min(6, size / 4);
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + inset(rect.width), rect.top + inset(rect.height)],
      [rect.right - inset(rect.width), rect.top + inset(rect.height)],
      [rect.left + inset(rect.width), rect.bottom - inset(rect.height)],
      [rect.right - inset(rect.width), rect.bottom - inset(rect.height)]
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
    const pinned = (element) => {
      for (let node = element; node && node !== document.body; node = node.parentElement || node.getRootNode?.().host) {
        const position = getComputedStyle(node).position;
        if (position === "fixed" || position === "sticky") return node;
      }
      return null;
    };
    const hits = points.map(([x, y]) => (active.getRootNode()?.elementFromPoint?.(x, y) || document.elementFromPoint(x, y)));
    const covering = hits.map((hit) => (!hit || hit === active || active.contains(hit) || hit.contains(active) ? null : pinned(hit)));
    if (points.length && covering.every(Boolean)) obscured = pathInRoot(covering[0], document) || covering[0].localName;
  }

  active.blur();
  const unfocused = snapshot();
  active.focus({ preventScroll: true });
  const changed = focused.some((value, position) => value !== unfocused[position]);
  const modal = active.closest('[aria-modal="true"],dialog[open]');
  return {
    target: segments,
    tag: active.localName,
    label: (active.getAttribute("aria-label") || active.textContent?.trim() || active.getAttribute("name") || "").replace(/\s+/g, " ").slice(0, 80),
    signature,
    hasIndicator: focusVisible && changed,
    refocused: active.matches(":focus"),
    obscured,
    inModal: Boolean(modal),
    radioGroup: active.matches('input[type="radio"]') && active.name ? `${active.form ? "form" : "doc"}:${active.name}` : null,
    rect: { top: rect.top + scrollY, left: rect.left + scrollX, width: rect.width, height: rect.height },
    viewportHeight: innerHeight,
    viewportWidth: innerWidth,
    computed: {
      outline: `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
      boxShadow: style.boxShadow
    }
  };
}

// Runs inside the page: controls that keyboard users must be able to reach.
function listKeyboardCandidates() {
  const pathInRoot = (element, scope) => {
    const parts = [];
    let current = element;
    while (current && current !== scope && current.nodeType === Node.ELEMENT_NODE) {
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const siblings = [...(current.parentElement?.children || scope.children || [])].filter((item) => item.localName === current.localName);
      const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      parts.unshift(`${current.localName || "*"}${suffix}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width >= 4 && rect.height >= 4;
  };
  const hiddenFromUsers = (element) => Boolean(element.closest('[aria-hidden="true"],[inert],[hidden]'));
  // Inside composite widgets, arrow keys (not Tab) move between items by design.
  const composite = '[role="tablist"],[role="menu"],[role="menubar"],[role="radiogroup"],[role="listbox"],[role="grid"],[role="tree"],[role="treegrid"],[role="toolbar"]';
  const nativeSelector = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,iframe,[contenteditable="true"]';
  const customRoles = /^(button|link|checkbox|radio|switch|tab|menuitem|option|slider|spinbutton|combobox|textbox|treeitem)$/;
  const results = [];
  for (const element of document.querySelectorAll(`${nativeSelector},[role],[onclick],[tabindex]`)) {
    if (results.length >= 600) break;
    if (!visible(element) || hiddenFromUsers(element) || element.matches(":disabled,[aria-disabled='true']")) continue;
    if (element.closest("[data-a11y-grounding-overlay],[data-a11y-evidence-overlay]")) continue;
    const native = element.matches(nativeSelector);
    const role = element.getAttribute("role") || "";
    const tabindexAttribute = element.getAttribute("tabindex");
    const inComposite = Boolean(element.parentElement?.closest(composite));
    const entry = {
      target: [pathInRoot(element, document)],
      signature: `${pathInRoot(element, document)}|${element.getAttribute("href") || ""}`,
      tag: element.localName,
      role,
      label: (element.getAttribute("aria-label") || element.textContent?.trim() || element.getAttribute("name") || element.getAttribute("title") || "").replace(/\s+/g, " ").slice(0, 80),
      tabindexAttribute,
      positiveTabindex: Number(tabindexAttribute) > 0,
      radioGroup: element.matches('input[type="radio"]') && element.name ? `${element.form ? "form" : "doc"}:${element.name}` : null,
      kind: null,
      reason: ""
    };
    if (native) {
      if (tabindexAttribute === "-1") entry.kind = inComposite ? null : "removed";
      else if (!inComposite) entry.kind = "native";
    } else if ((customRoles.test(role) || element.hasAttribute("onclick")) && element.tabIndex < 0 && !inComposite && !element.closest(nativeSelector)) {
      entry.kind = "custom-unfocusable";
      entry.reason = role ? `role="${role}"` : "click handler";
    }
    if (entry.kind || entry.positiveTabindex) results.push(entry);
  }
  return results;
}

function simpleHash(value) {
  let hash = 0;
  for (const char of value) hash = Math.imul(31, hash) + char.charCodeAt(0) | 0;
  return Math.abs(hash).toString(36);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}
