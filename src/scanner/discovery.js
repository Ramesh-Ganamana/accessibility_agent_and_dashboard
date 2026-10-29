import { isExcludedActionLabel, isUnsafeActionLabel, isUnsafeNavigationUrl } from "./actions.js";
import { documentType } from "./documents.js";
import { isExcludedActionUrl, prepareActionExclusions } from "../browser/action-exclusions.js";

export async function discoverNavigationActions(page, baseUrl, options = {}) {
  await prepareActionExclusions(page, options);
  const entries = await page.evaluate(() => {
    const found = [];
    const visit = (root) => {
      root.querySelectorAll?.("a[href], area[href]").forEach((anchor) => {
        if (window.__clarityActionExclusions?.matches(anchor)) return;
        const visibleText = (anchor.getAttribute("aria-label") || anchor.textContent || anchor.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        found.push({
          href: anchor.href,
          label: window.__clarityActionExclusions?.label(anchor) || visibleText || anchor.getAttribute("href") || "link",
          popup: anchor.target === "_blank",
          selector: anchor.id ? `#${CSS.escape(anchor.id)}` : `${anchor.localName}[href="${(anchor.getAttribute("href") || "").replaceAll('"', '\\"')}"]`
        });
      });
      root.querySelectorAll?.("*").forEach((element) => {
        if (element.shadowRoot) visit(element.shadowRoot);
      });
    };
    visit(document);
    return found;
  });

  const origin = new URL(baseUrl).origin;
  const unique = new Map();
  for (const entry of entries) {
    const url = normalizeUrl(entry.href);
    if (!url || new URL(url).origin !== origin) continue;
    // PDFs and office files are handled by the document checker, never crawled as
    // pages (their signed download links are kept out of the report as well).
    if (documentType(url)) continue;
    const label = String(entry.label || "link").slice(0, 120);
    // The normalized address is checked too: dropping a #fragment, a trailing
    // slash or tracking parameters must not turn into a listed URL.
    if (isUnsafeActionLabel(entry.label) || isUnsafeNavigationUrl(url) || isExcludedActionLabel(entry.label, options.excludeLabels)
      || isExcludedActionUrl(url, options.excludeLabels) || isExcludedActionUrl(entry.href, options.excludeLabels)) continue;
    const key = `${url}|${label}|${entry.popup}`;
    if (!unique.has(key)) unique.set(key, { url, label, popup: Boolean(entry.popup), selector: entry.selector });
  }
  return [...unique.values()];
}

export async function collectTechnologyNotes(page) {
  return page.evaluate(() => {
    let openShadowRoots = 0;
    let customElements = 0;
    const visit = (root) => {
      root.querySelectorAll?.("*").forEach((element) => {
        if (element.localName.includes("-")) customElements += 1;
        if (element.shadowRoot) {
          openShadowRoots += 1;
          visit(element.shadowRoot);
        }
      });
    };
    visit(document);
    return {
      openShadowRoots,
      customElements,
      dialogs: document.querySelectorAll('[role="dialog"], dialog').length,
      iframes: document.querySelectorAll("iframe").length
    };
  });
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (!/^#(?:!\/|\/)/.test(url.hash)) url.hash = "";
    [...url.searchParams.keys()].forEach((key) => {
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    });
    return url.href.replace(/\/$/, "") || url.href;
  } catch {
    return null;
  }
}
