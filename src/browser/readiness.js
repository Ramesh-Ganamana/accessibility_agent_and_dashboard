export async function waitForPageReady(page, options = {}) {
  const timeout = Number(options.timeout || 30_000);
  const settleMs = Number(options.settleMs || 900);
  const shellWaitMs = Number(options.shellWaitMs ?? timeout);
  const deadline = Date.now() + timeout;
  const remaining = (cap) => Math.max(0, Math.min(cap, deadline - Date.now()));

  await within(remaining(5_000), (time) => page.waitForLoadState("domcontentloaded", { timeout: time }));
  const visiblyReady = await waitForVisiblePage(page, remaining(timeout), shellWaitMs);
  if (!visiblyReady) await within(remaining(3_000), (time) => page.waitForLoadState("load", { timeout: time }));
  await waitForDomQuiet(page, settleMs, Math.max(0, visiblyReady ? 8_000 : remaining(8_000)));
  return visiblyReady;
}

export async function navigateAndWait(page, url, options = {}) {
  const timeout = Number(options.timeout || 45_000);
  const deadline = Date.now() + timeout;
  let response = null;
  let navigationError = null;
  try {
    response = await page.goto(url, { waitUntil: "commit", timeout: Math.min(timeout, 30_000) });
  } catch (error) {
    navigationError = error;
  }
  if ((navigationError && /interrupted by another navigation/i.test(navigationError.message || "")) || isTransientAuthenticationUrl(page.url(), url)) {
    await waitForAuthenticationRedirectToSettle(page, url, Math.min(30_000, Math.max(0, deadline - Date.now())));
  }
  const ready = await waitForPageReady(page, {
    timeout: Math.max(1, deadline - Date.now()),
    settleMs: Number(options.settleMs || 900),
    shellWaitMs: Number(options.shellWaitMs ?? Math.max(1, deadline - Date.now()))
  });
  const usable = await page.evaluate(() => Boolean(document.documentElement && document.body)).catch(() => false);
  const transientAuthentication = isTransientAuthenticationUrl(page.url(), url);
  if (navigationError && (!usable || page.url() === "about:blank" || transientAuthentication)) throw navigationError;
  if (transientAuthentication) throw new Error(`The authentication callback did not return to the requested application route: ${url}`);
  if (!ready) throw new Error(`The application did not render meaningful page content before the configured readiness timeout: ${url}`);
  return response;
}

export async function hasVisibleBusyState(page) {
  return (await inspectVisualState(page)).busy;
}

export async function detectPageAccessFailure(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length > 1_000) return null;
    const match = text.match(/^(forbidden|unauthorized|access denied|authentication failed)(?:[.! ]|$)/i);
    return match ? match[1] : null;
  }).catch(() => null);
}

export async function isPageVisiblyReady(page) {
  const state = await inspectVisualState(page);
  return state.ready;
}

async function inspectVisualState(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width >= 2 && rect.height >= 2;
    };
    const areaRatio = (element) => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
      const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
      return width * height / Math.max(1, innerWidth * innerHeight);
    };
    const loadingCandidates = [...document.querySelectorAll([
      '[aria-busy="true"]',
      '[data-loading="true"]',
      '[class*="loading" i]',
      '[class*="loader" i]',
      '[class*="spinner" i]',
      '[aria-label*="loading" i]'
    ].join(","))].filter(visible);
    const loadingText = [...document.querySelectorAll("body *")].slice(0, 2500).filter((element) => {
      if (!visible(element) || element.childElementCount > 3) return false;
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      return /^(loading|loading\.{1,3}|please wait|signing in|authenticating)\.?$/i.test(text);
    });
    const blockingLoader = loadingCandidates.some((element) => {
      const style = getComputedStyle(element);
      const ratio = areaRatio(element);
      return ratio >= .28 || ((style.position === "fixed" || style.position === "absolute") && ratio >= .18)
        || element === document.body || element === document.documentElement;
    });
    const visibleText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const interactiveCount = [...document.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[role="link"],[role="tab"]')].filter(visible).length;
    const mainSurface = [...document.querySelectorAll('main,[role="main"],form,#root,#app')].some((element) => visible(element) && areaRatio(element) >= .08 && (element.innerText || "").trim().length >= 20);
    const meaningfulSurface = mainSurface || interactiveCount >= 2 && visibleText.length >= 30 || Boolean(document.querySelector("h1,h2")) && interactiveCount >= 1;
    const applicationRoot = [...document.querySelectorAll('main,[role="main"],#root,#app')].some(visible);
    const applicationChrome = Boolean(document.querySelector('header,nav,aside,[role="navigation"],[role="banner"]')) || interactiveCount > 0;
    const emptyApplicationShell = !meaningfulSurface && applicationRoot && applicationChrome && visibleText.length < 30;
    const loaderPresent = loadingCandidates.length > 0 || loadingText.length > 0;
    const busy = blockingLoader || loaderPresent && !meaningfulSurface;
    const ready = !busy && !emptyApplicationShell && (meaningfulSurface || document.readyState === "complete");
    return { busy, ready, meaningfulSurface, emptyApplicationShell, readyState: document.readyState };
  }).catch(() => ({ busy: false, ready: false, meaningfulSurface: false, emptyApplicationShell: false, readyState: "unknown" }));
}

async function waitForVisiblePage(page, timeout, shellWaitMs) {
  if (timeout <= 0) return false;
  const startedAt = Date.now();
  const normalDeadline = startedAt + timeout;
  const shellDeadline = startedAt + Math.max(0, shellWaitMs);
  let emptyShellObserved = false;
  while (Date.now() < (emptyShellObserved ? Math.max(normalDeadline, shellDeadline) : normalDeadline)) {
    const state = await inspectVisualState(page);
    if (state.ready) return true;
    if (state.emptyApplicationShell) emptyShellObserved = true;
    if (emptyShellObserved && !state.busy && state.readyState === "complete" && Date.now() >= shellDeadline) return true;
    const activeDeadline = emptyShellObserved ? Math.max(normalDeadline, shellDeadline) : normalDeadline;
    await page.waitForTimeout(Math.min(300, Math.max(1, activeDeadline - Date.now()))).catch(() => {});
  }
  return isPageVisiblyReady(page);
}

async function waitForDomQuiet(page, settleMs, timeout) {
  if (timeout <= 0) return;
  await page.evaluate(({ settleMs, timeout }) => new Promise((resolve) => {
    let settledTimer;
    let timeoutTimer;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(settledTimer);
      clearTimeout(timeoutTimer);
      observer.disconnect();
      resolve();
    };
    const reset = () => {
      clearTimeout(settledTimer);
      settledTimer = setTimeout(finish, settleMs);
    };
    const observer = new MutationObserver(reset);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    timeoutTimer = setTimeout(finish, timeout);
    reset();
  }), { settleMs, timeout }).catch(() => {});
}

async function within(timeout, operation) {
  if (timeout <= 0) return;
  await operation(Math.max(1, timeout)).catch(() => {});
}

async function waitForAuthenticationRedirectToSettle(page, requestedUrl, timeout) {
  if (timeout <= 0) return;
  const deadline = Date.now() + timeout;
  let stableUrl = page.url();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (currentUrl !== stableUrl) {
      stableUrl = currentUrl;
      stableSince = Date.now();
    }
    if (!isTransientAuthenticationUrl(currentUrl, requestedUrl) && Date.now() - stableSince >= 700) return;
    const terminalError = await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      return /^(?:forbidden|unauthorized|access denied|authentication failed)(?:[.! ]|$)/i.test(text);
    }).catch(() => false);
    if (terminalError) return;
    await page.waitForTimeout(Math.min(200, Math.max(1, deadline - Date.now()))).catch(() => {});
  }
}

function isAuthenticationResponseUrl(value) {
  try {
    const url = new URL(value);
    return url.searchParams.has("code") && url.searchParams.has("state");
  } catch {
    return false;
  }
}

function isTransientAuthenticationUrl(value, requestedValue) {
  try {
    const current = new URL(value);
    const requested = new URL(requestedValue);
    if (isAuthenticationResponseUrl(current.href)) return true;
    const currentCallback = /(?:^|\/)(?:callback|signin-callback|oauth2?\/callback)(?:\/|$)/i.test(current.pathname);
    const requestedCallback = /(?:^|\/)(?:callback|signin-callback|oauth2?\/callback)(?:\/|$)/i.test(requested.pathname);
    return current.origin === requested.origin && currentCallback && !requestedCallback;
  } catch {
    return false;
  }
}
