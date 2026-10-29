import { restoreActionPath } from "../actions.js";
import { detectPageAccessFailure, navigateAndWait, waitForPageReady } from "../../browser/readiness.js";
import { sanitizeUrl } from "../../url-security.js";
import { actionExclusionScope, actionExclusionsFor, extendActionExclusionScope, isExcludedActionUrl, isInActionScope } from "../../browser/action-exclusions.js";

export function isFirstPartyFrame(frame, page, targetUrl) {
  if (frame === page.mainFrame()) return true;
  const value = frame.url();
  // about:blank, srcdoc, data and blob frames are authored by the embedding page.
  if (!value || /^(?:about:|data:|blob:)/i.test(value)) return true;
  try { return siteKey(new URL(value).hostname) === siteKey(new URL(targetUrl).hostname); } catch { return false; }
}

export function siteKey(hostname) {
  const labels = String(hostname || "").toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2 || /^\d+$/.test(labels.at(-1) || "")) return labels.join(".");
  const countryCodeSecondLevel = labels.at(-1).length === 2 && /^(?:co|com|org|net|gov|ac|edu|ne|or|go)$/.test(labels.at(-2));
  return labels.slice(countryCodeSecondLevel ? -3 : -2).join(".");
}

export function safeOriginOf(value) {
  try { return new URL(value).origin; } catch { return null; }
}

export function isSameSite(href, targetUrl) {
  try { return siteKey(new URL(href).hostname) === siteKey(new URL(targetUrl).hostname); } catch { return false; }
}

export async function openScanTarget({ page, url, replay, reuseCurrentPage, emit, config = {} }) {
  const shellWaitMs = Number.isFinite(Number(config.appShellWaitMs)) ? Number(config.appShellWaitMs) : 90_000;
  if (reuseCurrentPage) {
    await waitForPageReady(page, { timeout: 60_000, shellWaitMs, settleMs: 1_000 });
    return null;
  }

  if (replay?.baseUrl && replay?.path?.length) {
    emit({ type: "route-replay", message: "Opening the protected application route through its recorded in-app action path.", url });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const restored = await restoreActionPath(page, replay.baseUrl, replay.path, { expectedRootFingerprint: replay.rootFingerprint });
      if (!restored) continue;
      await waitForPageReady(page, { timeout: 50_000, shellWaitMs: 50_000, settleMs: 900 });
      const accessFailure = await detectPageAccessFailure(page);
      if (!accessFailure && samePageUrl(page.url(), url)) return null;
    }
    emit({ type: "crawl-warning", message: "The recorded in-app action path could not reopen the route; trying its URL in the same authenticated browser session.", url });
  }

  if (isExcludedActionUrl(url, actionExclusionsFor(config, url))) {
    throw Object.assign(new Error("This address is on the application's Do not click list; it was not opened."), { code: "USER_EXCLUDED_ACTION" });
  }
  return navigateAndWait(page, url, { timeout: 60_000, shellWaitMs, settleMs: 1_000 });
}

export function validateTarget(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Target URL must use http or https.");
  if (!/^#(?:!\/|\/)/.test(url.hash)) url.hash = "";
  return url.href.replace(/\/$/, "") || url.href;
}

export function cleanUrl(value) {
  return sanitizeUrl(value);
}

export function stableRestoreUrl(actualUrl, requestedUrl) {
  try {
    const actual = new URL(actualUrl);
    const requested = new URL(requestedUrl);
    const callbackPath = /(?:^|\/)(?:callback|signin-callback|oauth2?\/callback)(?:\/|$)/i.test(actual.pathname);
    const authorizationResponse = actual.searchParams.has("code") && actual.searchParams.has("state");
    if (actual.origin === requested.origin && (callbackPath || authorizationResponse)) return requested.href;
    return actual.href;
  } catch {
    return requestedUrl;
  }
}

export function sameOrigin(a, b) {
  return new URL(a).origin === new URL(b).origin;
}

// A start address often redirects to the site's canonical origin (feuji.com →
// www.feuji.com, http → https). The crawl then follows that origin; otherwise
// every link on the site would be treated as external. Only www/bare-domain
// variants and an upgrade to https qualify, so a redirect to a sign-in
// subdomain or another site never widens the scope.
export function adoptRedirectedOrigin(report, config, actualUrl, emit = () => {}) {
  let target;
  let actual;
  try { target = new URL(report.targetUrl); actual = new URL(actualUrl); } catch { return false; }
  if (target.origin === actual.origin || !["http:", "https:"].includes(actual.protocol)) return false;
  const bare = (hostname) => hostname.toLowerCase().replace(/^www\./, "");
  const sameHost = bare(target.hostname) === bare(actual.hostname);
  const protocolOk = target.protocol === actual.protocol || actual.protocol === "https:";
  const portOk = (target.port || "") === (actual.port || "") || target.protocol !== actual.protocol;
  if (!sameHost || !protocolOk || !portOk) return false;
  const previous = target.origin;
  report.targetUrl = `${actual.origin}${target.pathname}${target.search}`;
  if (config.excludeActionOrigin === previous) {
    config.excludeActionOrigin = actual.origin;
    if (report.configuration) report.configuration.excludedActionOrigin = actual.origin;
  }
  emit({ type: "scope", message: `The start address redirected to ${actual.origin}; the scan follows that origin.` });
  return true;
}

export function samePageUrl(a, b) {
  return cleanUrl(a) === cleanUrl(b);
}

// A start address can land on another host (app.example.com → portal.example.com)
// that adoptRedirectedOrigin does not adopt. The crawler still scans and uses
// that page, so the Do not click list applies there too; it is never cleared.
export async function applyExclusionsToLandingOrigin({ session, config, report, emit, url }) {
  const scope = actionExclusionScope(config);
  const origin = safeOriginOf(url);
  if (!scope.labels.length || !origin || !/^https?:/i.test(origin) || isInActionScope(url, scope.origins)) return;
  config.excludeActionOrigins = [...new Set([...(config.excludeActionOrigins || []), origin])];
  if (report.configuration) report.configuration.excludedActionOrigins = config.excludeActionOrigins;
  if (session?.context) await extendActionExclusionScope(session.context, origin);
  emit({ type: "scope", message: `The start address opened ${origin}; the Do not click list also applies there.` });
}

export function isExcluded(url, fragments) {
  const { pathname } = new URL(url);
  return fragments.some((fragment) => pathname.toLowerCase().includes(fragment.toLowerCase()));
}
