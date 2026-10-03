export async function scanKeyboardFocus(page, pageUrl, maxTabs = 24) {
  const findings = [];
  const visited = new Set();
  await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});

  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const segments = [];
      let root = document;
      let active = document.activeElement;

      const pathInRoot = (element, scope) => {
        if (element.id) return `#${CSS.escape(element.id)}`;
        const name = element.localName || "*";
        const siblings = [...(element.parentElement?.children || scope.children || [])]
          .filter((item) => item.localName === element.localName);
        const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(element) + 1})` : "";
        return `${name}${suffix}`;
      };

      while (active) {
        segments.push(pathInRoot(active, root));
        if (active.shadowRoot?.activeElement) {
          root = active.shadowRoot;
          active = active.shadowRoot.activeElement;
        } else break;
      }

      if (!active || active === document.body) return null;
      const style = getComputedStyle(active);
      const focusVisible = active.matches?.(":focus-visible") ?? false;
      const hasVisualIndicator = (element) => {
        const computed = getComputedStyle(element);
        const outlineVisible = computed.outlineStyle !== "none" && Number.parseFloat(computed.outlineWidth) >= 2;
        const shadowVisible = computed.boxShadow !== "none" && !/^rgba?\(0, 0, 0, 0\)/.test(computed.boxShadow);
        return outlineVisible || shadowVisible;
      };
      const indicatorChain = [];
      let candidate = active;
      while (candidate) {
        indicatorChain.push(candidate);
        candidate = candidate.parentElement || candidate.getRootNode?.().host || null;
      }
      const chainHasIndicator = indicatorChain.some(hasVisualIndicator);
      return {
        target: segments,
        tag: active.localName,
        label: active.getAttribute("aria-label") || active.textContent?.trim().slice(0, 80) || active.getAttribute("name") || "",
        signature: `${segments.join(" >>> ")}|${active.getAttribute("href") || ""}`,
        hasIndicator: focusVisible && chainHasIndicator,
        computed: {
          outline: `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
          boxShadow: style.boxShadow
        }
      };
    });

    if (!state) continue;
    if (visited.has(state.signature)) break;
    visited.add(state.signature);
    if (!state.hasIndicator) {
      findings.push({
        id: `focus-${simpleHash(`${pageUrl}-${state.signature}`)}`,
        findingType: "needs-review",
        ruleId: "focus-visible",
        impact: "serious",
        help: "Keyboard focus indicator may not be visible",
        description: "The focused interactive element did not expose a visible outline or box-shadow in its :focus-visible state.",
        helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html",
        tags: ["wcag2aa", "wcag247"],
        wcag: ["2.4.7"],
        target: state.target,
        html: `<${state.tag}>${escapeHtml(state.label)}</${state.tag}>`,
        failureSummary: `Observed outline: ${state.computed.outline}; box-shadow: ${state.computed.boxShadow}`,
        pageUrl,
        frameUrl: pageUrl,
        state: `keyboard-tab-${index + 1}`,
        evidence: null,
        source: "keyboard-traversal"
      });
    }
  }
  return findings;
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
