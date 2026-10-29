const URL_ENTRY = /^(?:https?:\/\/|\/|\.\.?\/)/i;

// One entry per line. Commas also separate entries on a line, except inside
// double quotes ("No, thanks"), after a backslash (No\, thanks) and inside the
// query of a link entry when no space follows (/report?ids=1,2).
function splitEntryLine(line) {
  const entries = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char !== '"') current += char;
      else if (line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = false;
    } else if (char === '"' && !current.trim() && line.indexOf('"', index + 1) > index) {
      current = "";
      quoted = true;
    } else if (char === "\\" && line[index + 1] === ",") {
      current += ",";
      index += 1;
    } else if (char === ",") {
      const rest = line.slice(index + 1);
      const insideQuery = URL_ENTRY.test(current.trim()) && current.includes("?") && /^\S/.test(rest) && !URL_ENTRY.test(rest);
      if (insideQuery) current += char;
      else { entries.push(current); current = ""; }
    } else current += char;
  }
  entries.push(current);
  return entries;
}

export function parseActionExclusions(value) {
  if (value != null && typeof value !== "string" && !Array.isArray(value)) throw new Error("Do not click entries must be text or a list of strings.");
  const items = Array.isArray(value) ? value : String(value || "").split(/\r\n|[\n\r\u2028\u2029]/).flatMap(splitEntryLine);
  if (items.some((item) => typeof item !== "string")) throw new Error("Every Do not click entry must be text.");
  const labels = [...new Set(items.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (labels.length > 100) throw new Error("Use at most 100 Do not click entries; no entries were applied.");
  if (labels.some((label) => label.length > 2048)) throw new Error("Each Do not click entry must be at most 2048 characters; entries are never truncated.");
  return labels;
}

// Entries from every source (EXCLUDE_ACTION_LABELS, the dashboard field, a
// journey) apply together; one source never replaces another.
export function mergeActionExclusions(...values) {
  return parseActionExclusions(values.flatMap((value) => parseActionExclusions(value)));
}

function originOf(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

const bareHost = (hostname) => String(hostname || "").toLowerCase().replace(/^www\./, "");

// The same application: the same origin, or its www/bare-host and http/https
// variants (the canonical redirects a start address commonly takes).
export function sameApplicationOrigin(left, right) {
  let a;
  let b;
  try { a = new URL(left); b = new URL(right); } catch { return false; }
  if (!/^https?:$/.test(a.protocol) || !/^https?:$/.test(b.protocol)) return false;
  if (a.origin === b.origin) return true;
  return bareHost(a.hostname) === bareHost(b.hostname) && (a.port === b.port || a.protocol !== b.protocol);
}

export function actionExclusionScope(config = {}) {
  const origins = [config.excludeActionOrigin, ...(config.excludeActionOrigins || [])].map(originOf).filter(Boolean);
  if (!origins.length) {
    const target = originOf(config.targetUrl);
    if (target) origins.push(target);
  }
  return { labels: config.excludeActionLabels || [], origins: [...new Set(origins)] };
}

export function isInActionScope(url, origins = []) {
  if (!origins.length) return true;
  return origins.some((origin) => sameApplicationOrigin(url, origin));
}

// The entries that apply on this URL: the whole list inside the application
// (including its www/https variants and adopted origins), nothing elsewhere.
export function actionExclusionsFor(config, url) {
  const scope = actionExclusionScope(config);
  return scope.labels.length && isInActionScope(url, scope.origins) ? scope.labels : [];
}

function canonicalUrl(value, base) {
  let url;
  try { url = base ? new URL(value, base) : new URL(value); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return url;
  if (!/^#!?\//.test(url.hash)) url.hash = "";
  if (url.search) {
    const params = new URLSearchParams(url.search);
    for (const key of [...params.keys()]) if (/^(?:utm_|fbclid$|gclid$)/i.test(key)) params.delete(key);
    url.search = params.toString();
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

// "url": absolute or /path entries; "host": host[:port][/path] without a
// scheme; "suffix": a path ending such as provider/search or logo.svg.
function urlRuleKind(raw) {
  if (/\s/.test(raw)) return null;
  if (URL_ENTRY.test(raw)) return "url";
  if (/^(?:localhost|\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(raw) && /[/?#:]/.test(raw)) return "host";
  if (/[/?]/.test(raw) || /\.[a-z][a-z0-9]{1,5}$/i.test(raw)) return "suffix";
  return null;
}

function urlRuleMatches(raw, kind, candidate, base) {
  const target = canonicalUrl(candidate, base);
  if (!target) return false;
  if (kind === "url") {
    const wanted = canonicalUrl(raw, base);
    if (!wanted) return false;
    if (wanted.href === target.href) return true;
    return sameApplicationOrigin(wanted.href, target.href) && wanted.pathname === target.pathname && wanted.search === target.search && wanted.hash === target.hash;
  }
  if (!/^https?:$/.test(target.protocol)) return false;
  if (kind === "host") {
    const wanted = canonicalUrl(`http://${raw}`);
    if (!wanted || bareHost(wanted.hostname) !== bareHost(target.hostname) || wanted.port && wanted.port !== target.port) return false;
    if (!/^[/?#]/.test(raw.replace(/^[^/?#]*/, ""))) return true;
    return wanted.pathname === target.pathname && wanted.search === target.search;
  }
  const wanted = raw.toLowerCase().replace(/^\.?\/+|\/+$/g, "");
  if (!wanted) return false;
  const path = safeDecode(target.pathname).toLowerCase();
  const ends = (value) => value === `/${wanted}` || value.endsWith(`/${wanted}`);
  return ends(path) || ends(path + safeDecode(target.search).toLowerCase()) || !wanted.includes("/") && bareHost(target.hostname) === bareHost(wanted);
}

// Link and path entries checked outside the page (queued routes, direct
// navigation, document downloads, journey goto steps).
export function isExcludedActionUrl(url, labels = []) {
  if (!url) return false;
  return labels.some((raw) => {
    const kind = urlRuleKind(raw);
    return Boolean(kind) && urlRuleMatches(raw, kind, url, url);
  });
}

// Runs in the document, before site scripts when installed on a browser session.
// Keep matching data local: do not export field values, signed URLs or aliases to AI.
export function installDocumentActionPolicy(options = {}) {
  const key = "__clarityActionExclusions";
  if (window[key]) {
    window[key].ensureListeners?.();
    if (options.labels !== undefined) window[key].setRules(options);
    return;
  }
  let labels = [];
  let origins = [];
  let version = 0;
  let rules = [];
  const normalize = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const bareHost = (hostname) => String(hostname || "").toLowerCase().replace(/^www\./, "");
  const safeDecode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };

  // Closed shadow roots are recorded when created; this script runs before the
  // page's own scripts, so their content can still be named and matched.
  const closedRoots = new WeakMap();
  try {
    const attach = Element.prototype.attachShadow;
    if (typeof attach === "function") {
      Element.prototype.attachShadow = function attachShadow(init) {
        const root = attach.call(this, init);
        if (init?.mode === "closed") closedRoots.set(this, root);
        return root;
      };
    }
  } catch {}
  const shadowOf = (element) => element.shadowRoot || closedRoots.get(element) || null;
  // Flat-tree parent: slotted content belongs to the slot (and the control
  // around it) inside the component, as browser events see it.
  const parent = (node) => node.assignedSlot || node.parentElement || node.parentNode?.host || null;
  const style = (element, pseudo) => { try { return getComputedStyle(element, pseudo); } catch { return null; } };

  const sameAppOrigin = (left, right) => {
    let a;
    let b;
    try { a = new URL(left); b = new URL(right); } catch { return false; }
    if (!/^https?:$/.test(a.protocol) || !/^https?:$/.test(b.protocol)) return false;
    if (a.origin === b.origin) return true;
    return bareHost(a.hostname) === bareHost(b.hostname) && (a.port === b.port || a.protocol !== b.protocol);
  };
  const inScope = () => {
    if (!origins.length) return true;
    let candidates;
    try { candidates = [window.top.location.origin]; }
    catch { candidates = [location.origin, ...Array.from(location.ancestorOrigins || [])]; }
    return candidates.some((origin) => origins.some((allowed) => sameAppOrigin(origin, allowed)));
  };

  // Real activatable owners. Focus containers (tabindex="-1", landmarks) are
  // not owners, so their names never block the controls inside them.
  const OWNER = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="option"],[role="treeitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="slider"],[role="spinbutton"],[onclick]';
  const CONTAINER = 'html,body,main,section,article,nav,header,footer,aside,form,dialog,[role="main"],[role="dialog"],[role="alertdialog"],[role="region"],[role="document"],[role="application"],[role="navigation"],[role="banner"],[role="contentinfo"]';
  const isOwner = (element) => {
    if (!(element instanceof Element) || element.matches("html,body")) return false;
    if (element.matches(OWNER)) return true;
    if (element.matches(CONTAINER)) return false;
    if (element.hasAttribute("tabindex") && element.tabIndex >= 0) return true;
    // A clickable box without semantics (a React card with a JS listener): the
    // element that sets the pointer cursor its content inherits.
    if (style(element)?.cursor !== "pointer") return false;
    const up = parent(element);
    return !(up instanceof Element) || style(up)?.cursor !== "pointer";
  };

  let cache = null;
  const cached = (kind, node, compute) => {
    if (!cache) {
      cache = new Map();
      queueMicrotask(() => { cache = null; });
    }
    let byNode = cache.get(kind);
    if (!byNode) cache.set(kind, byNode = new WeakMap());
    if (!byNode.has(node)) byNode.set(node, compute(node));
    return byNode.get(node);
  };

  const descendants = (element, selector, limit = 40) => {
    const found = [];
    const visit = (root) => {
      for (const match of root.querySelectorAll(selector)) {
        found.push(match);
        if (found.length >= limit) return;
      }
      let scanned = 0;
      for (const child of root.querySelectorAll("*")) {
        if (found.length >= limit || ++scanned > 3_000) return;
        const shadow = shadowOf(child);
        if (shadow) visit(shadow);
      }
    };
    visit(element);
    const own = shadowOf(element);
    if (own && found.length < limit) visit(own);
    return found.slice(0, limit);
  };

  const pseudoText = (element, which) => {
    const value = style(element, which)?.content;
    if (!value || value === "none" || value === "normal") return "";
    let text = "";
    for (const match of value.matchAll(/"((?:[^"\\]|\\.)*)"|attr\(\s*([\w-]+)\s*\)/g)) {
      text += match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : element.getAttribute(match[2]) || "";
    }
    return text;
  };
  const BLOCK = /^(?:block|flex|grid|table|table-row|table-cell|table-caption|list-item|flow-root)$/;
  // Name from content, close to the browser's accessible name: rendered text
  // over the flattened tree (slots, open and recorded closed shadow roots),
  // image alt text and descendant labels in place, generated ::before/::after
  // text, spaces at block boundaries, and nothing hidden or aria-hidden.
  const contentName = (root, skipOwners) => {
    let text = "";
    let budget = 300;
    let truncated = false;
    const add = (value) => {
      if (!value || truncated) return;
      text += value;
      if (text.length > 800) truncated = true;
    };
    const walk = (node, top) => {
      if (truncated) return;
      if (--budget < 0) { truncated = true; return; }
      if (node.nodeType === 3) { add(node.data); return; }
      if (node.nodeType === 11) { for (const child of node.childNodes) walk(child, false); return; }
      if (node.nodeType !== 1) return;
      const element = node;
      const tag = element.localName;
      if (!top) {
        if (skipOwners && isOwner(element)) return;
        if (element.getAttribute("aria-hidden") === "true" || element.hidden || tag === "script" || tag === "style" || tag === "template") return;
        const computed = style(element);
        if (computed && (computed.display === "none" || computed.visibility === "hidden")) return;
        const label = element.getAttribute("aria-label");
        if (label && label.trim()) { add(` ${label} `); return; }
        if (tag === "img" || tag === "area" || element.matches('input[type="image"]')) { add(` ${element.getAttribute("alt") || element.getAttribute("title") || ""} `); return; }
        if (tag === "svg") { add(` ${element.querySelector("title")?.textContent || ""} `); return; }
        if (element.matches("input,textarea,select")) return;
      }
      if (tag === "br") { add(" "); return; }
      const block = BLOCK.test(style(element)?.display || "");
      if (block) add(" ");
      add(pseudoText(element, "::before"));
      const shadow = shadowOf(element);
      if (tag === "slot") {
        const assigned = element.assignedNodes({ flatten: true });
        for (const child of assigned.length ? assigned : element.childNodes) walk(child, false);
      } else for (const child of (shadow || element).childNodes) walk(child, false);
      add(pseudoText(element, "::after"));
      if (block) add(" ");
    };
    walk(root, true);
    return truncated ? "" : compact(text);
  };

  const labelText = (element) => element ? element.getAttribute("aria-label") || contentName(element, false) || element.textContent || "" : "";
  const ownNames = (element) => {
    const root = element.getRootNode();
    const byId = (id) => root.getElementById?.(id) || document.getElementById(id);
    const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => labelText(byId(id))).join(" ");
    const nativeLabels = element.labels ? [...element.labels].map((label) => contentName(label, false) || label.textContent).join(" ") : "";
    // Never use entered text/password values. Button values are static labels.
    const buttonValue = element.matches('input[type="button"],input[type="submit"],input[type="reset"]') ? element.getAttribute("value") : "";
    return { labelledBy, ariaLabel: element.getAttribute("aria-label"), title: element.getAttribute("title"), alt: element.getAttribute("alt"), nativeLabels, buttonValue };
  };
  const NAME_SOURCES = 'img[alt],area[alt],img[title],img[aria-label],input[type="image"][alt],svg[aria-label],svg title,[role="img"][aria-label],[aria-label]';
  // Names are normalized once; text longer than any entry can never equal one.
  const prepared = (values) => values.map((value) => String(value || "")).filter((value) => value.trim() && value.length <= 4_096)
    .map((value) => { const text = normalize(value); return { text, squash: text.replace(/\s+/g, "") }; });
  // Every name a person could have typed for the control itself.
  const fullNames = (element) => cached("full", element, () => {
    const own = ownNames(element);
    const field = element.matches("input,textarea,select");
    const sources = descendants(element, NAME_SOURCES, 30).map((source) => source.getAttribute("aria-label") || source.getAttribute("alt") || source.getAttribute("title") || source.textContent);
    return prepared([own.labelledBy, own.ariaLabel, own.title, own.alt, own.nativeLabels, field ? "" : contentName(element, false), own.buttonValue,
      field ? "" : element.textContent, ...sources]);
  });
  // An outer control around the hit control: its own label and its own content,
  // without the names of the other controls nested inside it.
  const ownerNames = (element) => cached("owner", element, () => {
    const own = ownNames(element);
    return prepared([own.labelledBy, own.ariaLabel, own.title, own.alt, own.nativeLabels, own.buttonValue,
      element.matches("input,textarea,select") ? "" : contentName(element, true)]);
  });
  const aliasMatches = (rule, aliases) => aliases.some((alias) => alias.text === rule.norm || rule.squash && alias.squash === rule.squash
    || rule.words && alias.text.length <= 300 && rule.words.test(alias.text));
  const ownUrls = (element) => [element.getAttribute("href"), typeof element.href === "string" ? element.href : "",
    ...(element.matches('img,input[type="image"]') ? [element.getAttribute("src"), element.src, element.currentSrc] : [])].filter(Boolean);
  const fullUrls = (element) => cached("urls", element, () => [...ownUrls(element),
    ...descendants(element, "img", 20).flatMap((image) => [image.getAttribute("src"), image.src, image.currentSrc])].filter(Boolean));

  const canonicalUrl = (value, base) => {
    let url;
    try { url = new URL(value, base); } catch { return null; }
    if (!/^https?:$/.test(url.protocol)) return url;
    if (!/^#!?\//.test(url.hash)) url.hash = "";
    if (url.search) {
      const params = new URLSearchParams(url.search);
      for (const name of [...params.keys()]) if (/^(?:utm_|fbclid$|gclid$)/i.test(name)) params.delete(name);
      url.search = params.toString();
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url;
  };
  const urlRuleKind = (raw) => {
    if (/\s/.test(raw)) return null;
    if (/^(?:https?:\/\/|\/|\.\.?\/)/i.test(raw)) return "url";
    if (/^(?:localhost|\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(raw) && /[/?#:]/.test(raw)) return "host";
    if (/[/?]/.test(raw) || /\.[a-z][a-z0-9]{1,5}$/i.test(raw)) return "suffix";
    return null;
  };
  const urlRuleMatches = (rule, candidate) => {
    const target = canonicalUrl(candidate, document.baseURI);
    if (!target) return false;
    if (rule.urlKind === "url") {
      const wanted = canonicalUrl(rule.raw, document.baseURI);
      if (!wanted) return false;
      if (wanted.href === target.href) return true;
      return sameAppOrigin(wanted.href, target.href) && wanted.pathname === target.pathname && wanted.search === target.search && wanted.hash === target.hash;
    }
    if (!/^https?:$/.test(target.protocol)) return false;
    if (rule.urlKind === "host") {
      const wanted = canonicalUrl(`http://${rule.raw}`);
      if (!wanted || bareHost(wanted.hostname) !== bareHost(target.hostname) || wanted.port && wanted.port !== target.port) return false;
      if (!/^[/?#]/.test(rule.raw.replace(/^[^/?#]*/, ""))) return true;
      return wanted.pathname === target.pathname && wanted.search === target.search;
    }
    const wanted = rule.raw.toLowerCase().replace(/^\.?\/+|\/+$/g, "");
    if (!wanted) return false;
    const path = safeDecode(target.pathname).toLowerCase();
    const ends = (value) => value === `/${wanted}` || value.endsWith(`/${wanted}`);
    return ends(path) || ends(path + safeDecode(target.search).toLowerCase()) || !wanted.includes("/") && bareHost(target.hostname) === bareHost(wanted);
  };
  // A file name typed without its folder ("kp_desktop_icon") names the image or
  // page it links to: the last path segment, with or without its extension.
  const basenameMatches = (rule, candidate) => {
    const target = canonicalUrl(candidate, document.baseURI);
    if (!target || !/^https?:$/.test(target.protocol)) return false;
    const segment = normalize(safeDecode(target.pathname.split("/").filter(Boolean).pop() || ""));
    return Boolean(segment) && (segment === rule.norm || segment.replace(/\.[a-z0-9]{1,6}$/i, "") === rule.norm);
  };

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const compileRules = () => {
    rules = labels.map((raw) => {
      const norm = normalize(raw);
      const attribute = /^\[?\s*([a-zA-Z_:][\w:.-]*)\s*=\s*(["']?)(.*?)\2\s*\]?$/.exec(raw);
      let selector = null;
      if (/^[#.[]/.test(raw) || /^[a-z][\w-]*[#.[:]/i.test(raw)) {
        try { document.createDocumentFragment().querySelector(raw); selector = raw; } catch {}
      }
      return {
        raw, norm, selector,
        squash: norm.replace(/\s+/g, ""),
        urlKind: urlRuleKind(raw),
        attribute: attribute ? { name: attribute[1].toLowerCase(), value: normalize(attribute[3]) } : null,
        // Whole words or phrases: "Pay" blocks "Pay now" but not "Payroll".
        words: norm ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(norm)}(?![\\p{L}\\p{N}])`, "u") : null
      };
    });
  };

  // Plain words match names and naming attributes, a class only as a whole
  // class token, and links/images by URL or file name. Never inline script
  // source, styles or values a user typed.
  const WORD_ATTRIBUTE = /^(?:id|name|title|alt|aria-label|aria-description|aria-roledescription|placeholder|for|value|data-[\w.:-]+)$/;
  const URL_ATTRIBUTE = /^(?:href|src|srcset|action|formaction|poster|data|xlink:href|background)$/;
  const staticButton = 'input[type="button"],input[type="submit"],input[type="reset"],input[type="image"],button';
  const attributeEquals = (node, attribute) => {
    const value = node.getAttribute(attribute.name);
    if (value == null) return false;
    return attribute.name === "class" ? value.split(/\s+/).some((token) => normalize(token) === attribute.value) : normalize(value) === attribute.value;
  };
  const attributeMatches = (node, rule, words) => {
    for (const attribute of node.attributes) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (!value || value.length > 2048) continue;
      if (name === "class") {
        if (value.split(/\s+/).some((token) => normalize(token) === rule.norm)) return true;
        continue;
      }
      if (URL_ATTRIBUTE.test(name) || name.startsWith("data-") && /^(?:https?:\/\/|\/)/i.test(value)) {
        const addresses = name === "srcset" ? value.split(",").map((part) => part.trim().split(/\s+/)[0]) : [value];
        if (addresses.some((address) => rule.urlKind && urlRuleMatches(rule, address) || basenameMatches(rule, address))) return true;
        continue;
      }
      if (!words || !WORD_ATTRIBUTE.test(name) || name === "value" && !node.matches(staticButton)) continue;
      const text = normalize(value);
      if (text === rule.norm || rule.words && text.length <= 300 && rule.words.test(text)) return true;
    }
    return false;
  };
  const safeMatches = (node, selector) => { try { return node.matches(selector); } catch { return false; } };
  const ruleMatches = (rule, node, aliases, addresses, deep) => {
    if (rule.selector && safeMatches(node, rule.selector)) return true;
    if (rule.attribute && attributeEquals(node, rule.attribute)) return true;
    if (rule.urlKind && addresses.some((address) => urlRuleMatches(rule, address))) return true;
    if (aliasMatches(rule, aliases)) return true;
    if (attributeMatches(node, rule, true)) return true;
    // A clickable box (often a plain div on React sites) is excluded by the
    // images it shows, the same way names include their alt text.
    if (deep) {
      for (const image of descendants(node, 'img,svg,input[type="image"],[role="img"]', 20)) {
        if (rule.selector && safeMatches(image, rule.selector) || rule.attribute && attributeEquals(image, rule.attribute) || attributeMatches(image, rule, true)) return true;
      }
    }
    return false;
  };
  const fullMatch = (node) => {
    const aliases = fullNames(node);
    const addresses = fullUrls(node);
    return rules.some((rule) => ruleMatches(rule, node, aliases, addresses, true));
  };
  const ownerMatch = (node) => {
    const aliases = ownerNames(node);
    const addresses = ownUrls(node);
    return rules.some((rule) => {
      if (rule.selector && safeMatches(node, rule.selector)) return true;
      if (rule.attribute && attributeEquals(node, rule.attribute)) return true;
      if (rule.urlKind && addresses.some((address) => urlRuleMatches(rule, address))) return true;
      if (addresses.some((address) => basenameMatches(rule, address))) return true;
      return aliasMatches(rule, aliases);
    });
  };

  // The hit target and its nearest owning control are checked with every name,
  // URL and attribute. Outer controls the activation also reaches (a clickable
  // card or row) are checked by their own label and their own content.
  const evaluateChain = (chain) => {
    if (!labels.length || !inScope() || !chain.length) return false;
    const target = chain[0];
    if (fullMatch(target)) return true;
    let nearest = isOwner(target) ? target : null;
    for (const node of chain.slice(1)) {
      if (!isOwner(node)) continue;
      if (!nearest) {
        nearest = node;
        if (fullMatch(node)) return true;
      } else if (ownerMatch(node)) return true;
    }
    return false;
  };
  const chainFrom = (element) => {
    const chain = [];
    for (let node = element; node && chain.length < 80; node = parent(node)) if (node instanceof Element) chain.push(node);
    return chain;
  };
  const matches = (element) => element instanceof Element ? evaluateChain(chainFrom(element)) : false;

  const OPEN_DIALOG = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],.modal.show,.modal[open],[popover]:popover-open';
  const visible = (element) => {
    const computed = style(element);
    const rect = element.getBoundingClientRect();
    return Boolean(computed) && computed.display !== "none" && computed.visibility !== "hidden" && rect.width >= 2 && rect.height >= 2;
  };
  // Escape closes a dialog the same way its close control does, so it is not
  // pressed while an open dialog holds a control on the Do not click list.
  const openDialogHasExcludedControl = () => {
    if (!labels.length || !inScope()) return false;
    const surfaces = [];
    const roots = [document];
    for (let index = 0; index < roots.length && index < 200; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (safeMatches(element, OPEN_DIALOG) && visible(element)) surfaces.push(element);
        const shadow = shadowOf(element);
        if (shadow) roots.push(shadow);
      }
    }
    return surfaces.some((surface) => matches(surface) || descendants(surface, `${OWNER},img,svg,[role="img"],[tabindex]`, 200).some((element) => matches(element)));
  };
  const deepActive = () => {
    let focused = document.activeElement;
    for (let depth = 0; depth < 20; depth += 1) {
      const inner = focused && shadowOf(focused)?.activeElement;
      if (!inner) break;
      focused = inner;
    }
    return focused;
  };
  // A key pressed on a listed control activates or changes it; Enter in a form
  // field submits through the form's default button.
  const keyBlocked = (key) => {
    if (!labels.length || !inScope()) return false;
    const focused = deepActive();
    if (!focused || focused === document.body || focused === document.documentElement || /^(?:i?frame)$/.test(focused.localName)) return false;
    if (/^(?:Shift\+)?Tab$/i.test(String(key || ""))) return false;
    if (matches(focused) || radioGroupBlocked(focused)) return true;
    if (/(?:^|\+)(?:Numpad)?Enter$/i.test(String(key || ""))) {
      const form = focused.form || focused.closest?.("form");
      const submit = form && [...form.elements].find((element) => element.matches('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]'));
      if (submit && matches(submit)) return true;
    }
    return false;
  };
  const radioGroupBlocked = (element) => {
    if (!element.matches?.('input[type="radio"]') || !element.name) return false;
    const scope = element.form || element.getRootNode();
    return [...scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(element.name)}"]`)].some((radio) => radio !== element && matches(radio));
  };

  const policy = {
    blocked: 0,
    setRules(value) {
      const incomingLabels = [...new Set((value.labels || []).map(compact).filter(Boolean))];
      const incomingOrigins = [...new Set([...(value.origins || []), ...(value.origin ? [value.origin] : [])].filter(Boolean))];
      const next = Number(value.version);
      if (Number.isFinite(next) && next > 0) {
        // Init scripts may run in any order; an older, narrower rule set never wins.
        if (next < version) return;
        version = next;
        labels = incomingLabels;
        origins = incomingOrigins;
      } else if (!labels.length) {
        labels = incomingLabels;
        origins = incomingOrigins;
      } else {
        // Rules from a helper outside the session's registry only add.
        labels = [...new Set([...labels, ...incomingLabels])];
        origins = !origins.length || !incomingOrigins.length ? [] : [...new Set([...origins, ...incomingOrigins])];
      }
      compileRules();
    },
    matches,
    label(element) {
      const own = ownNames(element);
      const field = element.matches("input,textarea,select");
      const sources = descendants(element, "img[alt],area[alt],svg title", 10).map((image) => image.getAttribute("alt") || image.textContent);
      return [own.labelledBy, own.ariaLabel, own.title, own.alt, own.nativeLabels, field ? "" : contentName(element, false), own.buttonValue,
        field ? "" : element.textContent, ...sources].map(compact).find(Boolean) || "";
    },
    ensureListeners: () => ensureListeners(),
    openDialogHasExcludedControl,
    keyBlocked
  };
  policy.setRules(options);
  Object.defineProperty(window, key, { value: policy, configurable: false });

  // Defense in depth for late label changes, child hits, native keyboard
  // activation and helper paths. This is not a sandbox against hostile scripts.
  const SELECTION_KEY = /^(?:Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down)|Home|End)$/;
  const SELECTION_TARGET = 'select,input[type="radio"],input[type="checkbox"],[role="radio"],[role="listbox"],[role="combobox"],[role="slider"],[role="spinbutton"],[role="switch"]';
  const block = (event) => {
    const path = event.composedPath().filter((node) => node instanceof Element);
    const target = path[0];
    if (event.type.startsWith("key")) {
      if (!["Enter", " ", "Spacebar"].includes(event.key)) {
        // Arrow keys and typed characters change a listed select or radio group.
        if (!(SELECTION_KEY.test(event.key) || event.key?.length === 1) || !target?.matches?.(SELECTION_TARGET)) return;
        if (radioGroupBlocked(target)) { policy.blocked++; event.preventDefault(); event.stopImmediatePropagation(); return; }
      }
    }
    if ((event.type === "change" || event.type === "input") && !target?.matches?.('select,input[type="radio"],input[type="checkbox"]')) return;
    let excluded;
    if (event.type === "submit") {
      excluded = event.submitter ? matches(event.submitter) : target ? ownerMatch(target) && Boolean(labels.length) && inScope() : false;
    } else excluded = path.length ? evaluateChain(path) : matches(target);
    if (!excluded) return;
    policy.blocked++;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const TYPES = ["click", "auxclick", "dblclick", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "keydown", "keyup", "keypress", "submit", "change", "input"];
  const PROBE = "__clarity-action-policy-probe";
  let heard = false;
  const onProbe = () => { heard = true; };
  const listen = () => {
    for (const type of TYPES) window.addEventListener(type, block, { capture: true, passive: false });
    window.addEventListener(PROBE, onProbe, true);
  };
  // document.open() erases window listeners; put them back whenever a helper
  // checks or prepares the page.
  const ensureListeners = () => {
    heard = false;
    try { window.dispatchEvent(new Event(PROBE)); } catch {}
    if (!heard) listen();
  };
  listen();
}

const contextScopes = new WeakMap();
let scopeVersion = 0;

export async function installActionExclusions(context, config) {
  const scope = { ...actionExclusionScope(config), version: ++scopeVersion };
  contextScopes.set(context, scope);
  await context.addInitScript(installDocumentActionPolicy, scope);
  await ensureNavigationGuard(context);
}

// Listed page and link addresses are also refused at the network layer, so a
// script-started navigation (location.href = listed URL) never loads them.
// Routing is enabled only when the list contains addresses.
const guardedContexts = new WeakSet();
async function ensureNavigationGuard(context) {
  const scope = contextScopes.get(context);
  if (!scope || guardedContexts.has(context) || typeof context.route !== "function" || !scope.labels.some((label) => urlRuleKind(label))) return;
  guardedContexts.add(context);
  await context.route("**/*", (route) => {
    const request = route.request();
    const current = contextScopes.get(context);
    if (request.isNavigationRequest() && current && isExcludedActionUrl(request.url(), current.labels)) return route.abort("blockedbyclient").catch(() => {});
    return route.fallback().catch(() => {});
  });
}

// The application can also be reached on another origin (a start address that
// lands on a sibling host). The list then also applies there; it is never narrowed.
export async function extendActionExclusionScope(context, origin) {
  const scope = contextScopes.get(context);
  const added = originOf(origin);
  if (!scope || !added || !scope.origins.length || isInActionScope(added, scope.origins)) return false;
  const next = { labels: scope.labels, origins: [...scope.origins, added], version: ++scopeVersion };
  contextScopes.set(context, next);
  await context.addInitScript(installDocumentActionPolicy, next);
  await Promise.all(context.pages().map((page) => applyRules(page, next)));
  return true;
}

async function applyRules(page, rules) {
  await Promise.all(page.frames().map((frame) => frame.evaluate(installDocumentActionPolicy, rules).catch(() => {})));
}

// Re-primes every frame with the application's list. Labels passed here are
// added to that list; they never clear or narrow it.
export async function prepareActionExclusions(page, options = {}) {
  const context = page.context?.();
  const scope = contextScopes.get(context);
  let rules = scope || {};
  if (options.excludeLabels !== undefined) {
    const labels = [...new Set([...(scope?.labels || []), ...options.excludeLabels])];
    const origins = scope?.origins?.length ? scope.origins : [originOf(page.url())].filter(Boolean);
    rules = { ...(scope || {}), labels, origins };
    // Added entries stay for the rest of the session, like the configured ones.
    if (scope && labels.length > scope.labels.length) {
      contextScopes.set(context, rules);
      await ensureNavigationGuard(context);
    }
  }
  await applyRules(page, rules);
}

export async function isActionExcluded(locator) {
  // Failed inspection must not turn into permission to click a stale element.
  return inspectAction(locator).catch(() => true);
}

function inspectAction(locator) {
  return locator.evaluate((element) => {
    const policy = window.__clarityActionExclusions;
    policy?.ensureListeners?.();
    return Boolean(policy?.matches(element));
  });
}

function exclusionError(message) {
  return Object.assign(new Error(message), { code: "USER_EXCLUDED_ACTION" });
}

export async function assertActionAllowed(locator) {
  // Every guarded action re-primes the page from the session's list first, so a
  // stale or missing in-page rule set can never fail open.
  const page = locator.page?.();
  if (page && !page.isClosed?.()) await prepareActionExclusions(page);
  let excluded;
  try {
    excluded = await inspectAction(locator);
  } catch (error) {
    // Still refused, but not blamed on the Do not click list.
    throw Object.assign(new Error(`The action target could not be inspected safely, so it was not used: ${String(error?.message || error).split("\n", 1)[0]}`), { code: "ACTION_TARGET_UNAVAILABLE" });
  }
  if (excluded) throw exclusionError("Action blocked by the application's Do not click list. Review the conflicting exclusion before allowing this step.");
}

// Keys pressed on a focused listed control (or Enter that submits through a
// listed default button) are refused like clicks.
export async function assertKeyAllowed(page, key) {
  await prepareActionExclusions(page);
  const verdicts = await Promise.all(page.frames().map((frame) => frame.evaluate((value) => Boolean(window.__clarityActionExclusions?.keyBlocked?.(value)), key).catch(() => false)));
  if (verdicts.some(Boolean)) throw exclusionError("Key press blocked: the focused control (or the form's default button) is on the application's Do not click list.");
}

// True while an open dialog contains a listed control: Escape would dismiss
// it the way that control does.
export async function excludedControlInOpenDialog(page) {
  if (page.isClosed?.()) return false;
  const verdicts = await Promise.all(page.frames().map((frame) => frame.evaluate(() => Boolean(window.__clarityActionExclusions?.openDialogHasExcludedControl?.())).catch(() => false)));
  return verdicts.some(Boolean);
}

export async function actionBlockCount(page) {
  const counts = await Promise.all(page.frames().map((frame) => frame.evaluate(() => Number(window.__clarityActionExclusions?.blocked || 0)).catch(() => 0)));
  return counts.reduce((sum, value) => sum + value, 0);
}

export async function guardedClick(locator, options) {
  await assertActionAllowed(locator);
  const handle = await locator.elementHandle();
  if (!handle) throw new Error("The action target disappeared before clicking.");
  try {
    const before = await handle.evaluate(() => window.__clarityActionExclusions?.blocked || 0);
    await locator.click(options);
    // Use the retained handle: looking the locator up after navigation can wait
    // 30 seconds for a control that belonged to the previous document.
    const blocked = await handle.evaluate(() => window.__clarityActionExclusions?.blocked || 0).catch(() => before);
    if (blocked > before) throw exclusionError("Action blocked by the application's Do not click list after the control changed.");
  } finally { await handle.dispose(); }
}
