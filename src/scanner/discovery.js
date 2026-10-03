export async function discoverPageLinks(page, baseUrl) {
  const actions = await discoverNavigationActions(page, baseUrl);
  return [...new Set(actions.filter((action) => !action.popup).map((action) => action.url))];
}

export async function discoverPopupLinks(page, baseUrl) {
  const actions = await discoverNavigationActions(page, baseUrl);
  return [...new Set(actions.filter((action) => action.popup).map((action) => action.url))];
}

export async function discoverNavigationActions(page, baseUrl) {
  const entries = await page.evaluate(() => {
    const found = [];
    const visit = (root) => {
      root.querySelectorAll?.("a[href], area[href]").forEach((anchor) => {
        const visibleText = (anchor.getAttribute("aria-label") || anchor.textContent || anchor.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        found.push({
          href: anchor.href,
          label: visibleText || anchor.getAttribute("href") || "link",
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
    const label = String(entry.label || "link").slice(0, 120);
    const key = `${url}|${label}|${entry.popup}`;
    if (!unique.has(key)) unique.set(key, { url, label, popup: Boolean(entry.popup), selector: entry.selector });
  }
  return [...unique.values()];
}

export async function findDialogTriggers(page) {
  return page.locator([
    '[aria-haspopup="dialog"]',
    '[data-toggle="modal"]',
    '[data-bs-toggle="modal"]'
  ].join(", "));
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
