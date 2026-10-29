import path from "node:path";
import { chromium, devices } from "playwright";
import { detectSecurityChallenge, findLoginControlWithAI } from "./ai-login.js";
import { hasVisibleBusyState, navigateAndWait, waitForPageReady } from "./readiness.js";
import { resolvePostLoginObstructions, waitForPostLoginObstruction } from "./post-login.js";
import { readSavedSession, writeSavedSession } from "./session-store.js";
import { installActionExclusions, assertActionAllowed, guardedClick } from "./action-exclusions.js";

export async function createBrowserSession(config, onEvent = () => {}) {
  const browser = await launchCompatibleBrowser(config, onEvent);
  const sessionHost = config.targetUrl || config.login?.url;
  const authStatePath = scopedAuthStatePath(config.authStatePath, sessionHost);
  const legacyAuthStatePath = config.legacyAuthStatePath ? scopedAuthStatePath(config.legacyAuthStatePath, sessionHost) : null;
  // Actual NVDA needs a real desktop window, so it never runs under emulation.
  const nvdaWindow = config.nvda?.requested && !config.nvdaRunner && !config.nvdaSessionFactory;
  const mobile = config.device === "mobile" && !nvdaWindow ? devices["Pixel 7"] : null;
  const contextOptions = {
    ...(mobile ? { userAgent: mobile.userAgent, screen: mobile.screen, deviceScaleFactor: mobile.deviceScaleFactor, isMobile: true, hasTouch: true } : {}),
    viewport: nvdaWindow ? null : mobile ? mobile.viewport : { width: 1440, height: 960 },
    reducedMotion: "reduce",
    locale: "en-US",
    colorScheme: "light",
    // Typing a password into a page with a broken or intercepted certificate is
    // never silent. Set IGNORE_HTTPS_ERRORS=true for a trusted self-signed QA host.
    ignoreHTTPSErrors: config.ignoreHttpsErrors ?? !hasCredentials(config)
  };

  // Saved sessions are read from the encrypted per-user store first. Plain files
  // from earlier versions are still read; the next save replaces them encrypted.
  let loadedStorage = false;
  if (config.login.persist) {
    try {
      const saved = await readSavedSession(authStatePath, legacyAuthStatePath);
      if (saved) {
        contextOptions.storageState = saved.state;
        loadedStorage = true;
        onEvent({ type: "session", message: saved.encrypted ? "Loaded the encrypted saved session for this application." : "Loaded a saved session from an older unencrypted file; it will be re-saved encrypted after the next login." });
      }
    } catch (error) {
      onEvent({ type: "crawl-warning", message: `The saved session could not be read and was ignored (${firstLine(error.message)}). Sign in again to replace it.` });
    }
  }

  const context = await browser.newContext(contextOptions);
  await installActionExclusions(context, config);
  // Site-opened tabs only: popups of the home tab, of internal tabs and of other
  // site tabs. Tabs the user opens and the agent's own tabs are never listed.
  const popupPages = new Set();
  const internalPages = new Set();
  const userTabs = new Set();
  const handledTabs = new WeakSet();
  const agentClosing = new WeakSet();
  const internalCreations = new Set();
  const stopController = new AbortController();
  const stopListeners = new Set();
  let stopReason = null;
  let closingIntentionally = false;
  let closePromise = null;

  // Only raises the flag. Scripts close session.page or the browser on purpose and
  // must keep working, so nothing is closed from here.
  const markStopped = (message) => {
    if (closingIntentionally || stopReason) return;
    stopReason = { code: "TEST_BROWSER_CLOSED", message };
    stopController.abort(stoppedError(stopReason));
    try { onEvent({ type: "browser-closed", message: "The test browser was closed; the scan is stopping and keeps the results so far." }); } catch {}
    for (const listener of [...stopListeners]) notifyStopped(listener);
  };
  const notifyStopped = (listener) => {
    stopListeners.delete(listener);
    try { listener(stopReason)?.catch?.(() => {}); } catch {}
  };

  const page = await context.newPage();
  wirePage(page, onEvent);
  // Closing the window can fire only the home tab's 'close' (no context 'close' or
  // 'disconnected' while the browser process lives on), so that is the primary trigger.
  page.once("close", () => markStopped("The test browser window or its scan tab was closed."));
  page.on("crash", () => markStopped("The test browser's scan tab crashed."));
  context.once("close", () => markStopped("The test browser was closed."));
  browser.once("disconnected", () => markStopped("The test browser disconnected."));

  const adoptSiteTab = (tab) => {
    if (tab === page || popupPages.has(tab) || internalPages.has(tab)) return;
    popupPages.add(tab);
    userTabs.delete(tab);
    wirePage(tab, onEvent);
    tab.on("popup", adoptSiteTab);
    tab.once("close", () => popupPages.delete(tab));
    onEvent({ type: "popup", message: "Detected a new browser window or popup.", url: tab.url() });
  };
  page.on("popup", adoptSiteTab);

  // The opener's 'popup' event fires synchronously right after the context 'page'
  // event, so a tab still unclaimed a microtask later came from the agent's own
  // newInternalPage() or from the user (Ctrl+T, a bookmark). User tabs are left alone.
  const classifyUnclaimedTab = async (tab) => {
    if (popupPages.has(tab) || internalPages.has(tab)) return;
    if (internalCreations.size) await Promise.allSettled([...internalCreations]);
    if (popupPages.has(tab) || internalPages.has(tab) || tab.isClosed()) return;
    userTabs.add(tab);
    tab.once("close", () => userTabs.delete(tab));
    onEvent({ type: "user-tab", message: "A tab opened outside the scan was detected; it is left open and not tested." });
  };
  context.on("page", (tab) => {
    if (tab === page) return;
    queueMicrotask(() => { classifyUnclaimedTab(tab).catch(() => {}); });
  });

  return {
    browser,
    context,
    page,
    popupPages,
    loadedStorage,
    authStatePath,
    signal: stopController.signal,
    get stopReason() { return stopReason; },
    isStopped() { return Boolean(stopReason); },
    throwIfStopped() { if (stopReason) throw stoppedError(stopReason); },
    onStopped(listener) {
      stopListeners.add(listener);
      if (stopReason) queueMicrotask(() => { if (stopListeners.has(listener)) notifyStopped(listener); });
      return () => { stopListeners.delete(listener); };
    },
    // An agent-owned tab (the after-crawl NVDA pass). It is not a popup and never
    // shows up in pendingTabs(); the user closing it stops the scan like the home tab.
    async newInternalPage() {
      if (stopReason) throw stoppedError(stopReason);
      const creation = context.newPage().then((tab) => {
        internalPages.add(tab);
        wirePage(tab, onEvent);
        tab.on("popup", adoptSiteTab);
        // The agent closes its own tab through page.close() when the pass ends;
        // only a close it did not ask for counts as the user closing the browser.
        const closeTab = tab.close.bind(tab);
        tab.close = (options) => { agentClosing.add(tab); return closeTab(options); };
        tab.once("close", () => {
          internalPages.delete(tab);
          if (!agentClosing.has(tab)) markStopped("The scan's own test tab was closed.");
        });
        return tab;
      });
      internalCreations.add(creation);
      try { return await creation; } finally { internalCreations.delete(creation); }
    },
    pendingTabs() {
      return [...popupPages].filter((tab) => !tab.isClosed() && !handledTabs.has(tab));
    },
    markTabHandled(tab) {
      if (tab) handledTabs.add(tab);
    },
    userTabs() {
      return [...userTabs].filter((tab) => !tab.isClosed());
    },
    async persist() {
      return writeSavedSession(await context.storageState(), authStatePath);
    },
    async close() {
      // Teardown closes the home tab too; flag it first so it never reads as the
      // user closing the browser.
      closingIntentionally = true;
      closePromise ||= (async () => {
        try { await context.close(); } finally { await browser.close(); }
      })();
      return closePromise;
    }
  };
}

function stoppedError(reason) {
  const error = new Error(reason?.message || "The test browser was closed.");
  error.code = "TEST_BROWSER_CLOSED";
  return error;
}

async function launchCompatibleBrowser(config, onEvent) {
  const requested = String(config.browserChannel || "auto").toLowerCase();
  const candidates = requested === "auto"
    ? (process.platform === "win32" ? ["msedge", "chrome", null] : [null, "chrome"])
    : requested === "bundled" ? [null] : [requested];
  const errors = [];

  for (const channel of candidates) {
    try {
      const browser = await chromium.launch({
        headless: config.headless,
        ...(!config.headless ? { args: ["--start-maximized"] } : {}),
        ...(channel ? { channel } : {})
      });
      onEvent({
        type: "session",
        message: `Browser started with ${channel || "Playwright Chromium"}.`
      });
      return browser;
    } catch (error) {
      errors.push(`${channel || "bundled"}: ${firstLine(error.message)}`);
    }
  }

  const error = new Error(
    "Windows blocked every available browser engine. Close running browser processes, set BROWSER_CHANNEL=msedge in .env, and start the dashboard from a normal PowerShell window. " +
    `Attempts: ${errors.join(" | ")}`
  );
  error.code = "BROWSER_LAUNCH_FAILED";
  throw error;
}

function firstLine(value) {
  return String(value || "Unknown launch error").split(/\r?\n/, 1)[0];
}

function hasCredentials(config) {
  return Boolean(config.login?.url && config.login?.email && config.login?.password);
}

function shellWait(config) {
  return Number.isFinite(Number(config.appShellWaitMs)) ? Number(config.appShellWaitMs) : 90_000;
}

function wirePage(page, onEvent) {
  page.on("dialog", async (dialog) => {
    onEvent({
      type: "dialog",
      message: `Handled ${dialog.type()} dialog: ${dialog.message()}`,
      url: page.url()
    });
    // Dismissing beforeunload means "stay on page", which would let a site cancel
    // the user closing the test window. Alerts, confirms and prompts stay dismissed.
    await (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(() => {});
  });

  page.on("pageerror", (error) => {
    onEvent({ type: "page-error", message: error.message, url: page.url() });
  });
}

export async function ensureAuthenticated(session, config, onEvent = () => {}, options = {}) {
  if (!config.login.url || !config.login.email || !config.login.password) return false;

  const page = session.page;
  if (options.useCurrentPage) await waitForPageReady(page, { timeout: 60_000, shellWaitMs: shellWait(config), settleMs: 700 });
  else await navigateAndWait(page, config.login.url, { timeout: 60_000, shellWaitMs: shellWait(config), settleMs: 700 });

  if (session.loadedStorage && await isAuthenticatedDestination(page, config)) {
    onEvent({ type: "session", message: "The saved session is already authenticated; continuing with the application.", url: page.url() });
    if (await waitForPostLoginObstruction(page)) {
      onEvent({ type: "post-login", message: "A blocking post-login dialog appeared; inspecting it now.", url: page.url() });
      await resolvePostLoginObstructions(page, config, onEvent);
    }
    return true;
  }
  onEvent({ type: "session", message: "Waiting for the login provider and username field." });

  const usernameSelectors = [
    config.login.emailSelector,
    '#signInName, input[type="email"], input[autocomplete="username"], input[type="text"][name*="user" i], input[type="text"][id*="user" i], input[type="text"][name*="email" i], input[type="text"][id*="email" i], input[type="text"][name*="login" i], input[type="text"][id*="login" i], input[type="text"][placeholder*="user" i], input[type="text"][placeholder*="email" i], input[type="text"][aria-label*="user" i], input[type="text"][aria-label*="email" i]'
  ];
  let username = await waitForControl(page, usernameSelectors, 3_000, "fill_username");
  if (!username) username = await aiControl(page, "fill_username", config, onEvent);
  if (!username) username = await waitForControl(page, usernameSelectors, 8_000, "fill_username");

  if (!username) {
    const entrySelectors = [
      'a[href*="login" i], a[href*="log-in" i], a[href*="signin" i], a[href*="sign-in" i]',
      'button[id*="login" i], button[id*="signin" i], [role="button"][id*="login" i], [role="button"][id*="signin" i]',
      '[aria-label*="log in" i], [aria-label*="login" i], [aria-label*="sign in" i], [aria-label*="my account" i]',
      '[data-testid*="login" i], [data-testid*="signin" i]',
      'button:has-text("Continue"), [role="button"]:has-text("Continue"), input[type="button"][value*="continue" i], input[type="submit"][value*="continue" i]'
    ];
    const entry = await resolveControl(page, entrySelectors, "click_login_entry", config, onEvent, 2_000, 3_000);
    if (entry) {
      onEvent({ type: "session", message: "Opening the application login flow." });
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 25_000 }).catch(() => {}),
        guardedClick(entry)
      ]);
      await waitForPageReady(page, { timeout: 25_000, settleMs: 700 });
    }
    username = await resolveControl(page, usernameSelectors, "fill_username", config, onEvent, 15_000, 20_000);
  }
  if (!username) {
    const challenge = await detectSecurityChallenge(page);
    throw loginError(challenge
      ? `User action required: complete the ${challenge}, then retry the scan.`
      : "Automatic login discovery could not find an enabled username/email field after waiting for redirects. Check the login-entry URL and visible login page. Advanced selectors are an optional fallback for unusual forms.");
  }
  await assertActionAllowed(username);
  await username.fill(config.login.email);

  let password = await resolveControl(page, [config.login.passwordSelector, 'input[type="password"]'], "fill_password", config, onEvent, 1_200, 500);
  if (!password) {
    let next = await resolveControl(page, [config.login.submitSelector, '#continue, #next, button[type="submit"], input[type="submit"], [role="button"][aria-label*="continue" i], [role="button"][aria-label*="next" i], [role="button"][aria-label*="sign in" i]'], "click_auth_continue", config, onEvent, 2_000, 3_000);
    if (!next) throw loginError("The username was filled, but a Continue/Next button was not found.");
    onEvent({ type: "session", message: "Username submitted; waiting for the password stage." });
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {}),
      guardedClick(next)
    ]);
    await waitForPageReady(page, { timeout: 25_000, settleMs: 700 });
    password = await resolveControl(page, [config.login.passwordSelector, 'input[type="password"]'], "fill_password", config, onEvent, 8_000, 22_000);
  }
  if (!password) {
    const challenge = await detectSecurityChallenge(page);
    throw loginError(challenge
      ? `User action required: complete the ${challenge}, then create or reuse an authenticated browser session.`
      : "Password field was not found after submitting the username. This account may require SSO, MFA, or a custom selector.");
  }
  await assertActionAllowed(password);
  await password.fill(config.login.password);

  let submit = await resolveControl(page, [config.login.submitSelector, '#signIn, #continue, button[type="submit"], input[type="submit"], [role="button"][aria-label*="sign in" i], [role="button"][aria-label*="login" i], [role="button"][aria-label*="log in" i], [role="button"][aria-label*="submit" i]'], "click_auth_continue", config, onEvent, 2_000, 3_000);
  if (!submit) throw loginError("Password was filled, but the final sign-in button was not found.");
  onEvent({ type: "session", message: "Submitting the password and waiting for the application callback." });
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {}),
    guardedClick(submit)
  ]);
  const authOutcome = await waitForAuthenticationOutcome(page, config, 45_000);
  if (authOutcome.status === "error") throw loginError(authOutcome.message);
  if (authOutcome.status === "challenge") throw loginError(`User action required: complete the ${authOutcome.message}, then retry the scan.`);
  if (authOutcome.status === "timeout") {
    throw loginError("The identity provider did not accept or redirect the password stage within 45 seconds. Verify the credentials and check the provider message shown on the login page.");
  }
  await waitForPageReady(page, { timeout: 60_000, shellWaitMs: shellWait(config), settleMs: 900 });

  if (await hasVisibleBusyState(page)) {
    throw loginError("Authentication is still covered by a blocking loading screen and no usable page is visible.");
  }

  const visiblePassword = await findControl(page, [config.login.passwordSelector, 'input[type="password"]']);
  if (visiblePassword) {
    const message = await visibleLoginError(page);
    throw loginError(message || "The login page still shows the password field. Verify the credentials or the authentication flow.");
  }

  const targetOrigin = safeOrigin(config.targetUrl);
  if (targetOrigin && safeOrigin(page.url()) !== targetOrigin) {
    const returned = await waitForOrigin(page, targetOrigin, 30_000);
    if (!returned) {
      throw loginError("The credentials were submitted, but the identity provider did not return to the application. Complete any required account choice, consent, MFA, or organization step and try again.");
    }
    await waitForPageReady(page, { timeout: 30_000, shellWaitMs: shellWait(config), settleMs: 900 });
  }
  if (await waitForPostLoginObstruction(page)) {
    onEvent({ type: "post-login", message: "A blocking post-login dialog appeared; inspecting it now.", url: page.url() });
    await resolvePostLoginObstructions(page, config, onEvent);
  }
  if (config.login.persist) {
    try {
      const saved = await session.persist();
      onEvent({ type: "session", message: saved?.encrypted ? "Login completed and the session was saved encrypted for your Windows account." : "Login completed and the local browser session was refreshed." });
    } catch (error) {
      // A failed save must not fail an authenticated scan; it only means the
      // next scan signs in again.
      onEvent({ type: "crawl-warning", message: `Login completed, but the session could not be saved (${firstLine(error.message)}). The next scan will sign in again.` });
    }
  } else {
    onEvent({ type: "session", message: "Login completed for this scan only; the session was not saved." });
  }
  return true;
}

// Registration, password-change, profile and user-management forms also hold a
// password field. Only a plain sign-in form may receive the tester's credentials.
export async function isLoginSurface(page) {
  for (const frame of page.frames()) {
    const verdict = await frame.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 2 && rect.height >= 2;
      };
      const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
      if (!passwords.length) return "none";
      if (passwords.length > 1) return "reject";
      const password = passwords[0];
      if (/new-password/i.test(password.getAttribute("autocomplete") || "")) return "reject";
      const scope = password.closest('form,[role="dialog"],dialog,[aria-modal="true"]') || document.body;
      const describe = (element) => `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`;
      const framing = [...scope.querySelectorAll('h1,h2,h3,legend,label,[role="heading"]')].filter(visible).map(describe).join(" ");
      if (/\b(sign\s*up|register|registration|enrol+|create\s+(?:an?\s+)?(?:account|user|profile)|new\s+(?:account|user|member|employee|password)|add\s+(?:an?\s+)?(?:user|member|employee|account)|invite|confirm\s+(?:your\s+)?password|re-?(?:enter|type)\s+password|change\s+(?:your\s+)?password|update\s+(?:your\s+)?password|reset\s+(?:your\s+)?password|current\s+password|account\s+settings|profile|security\s+settings)\b/i.test(framing)) return "reject";
      const fields = [...scope.querySelectorAll('input:not([type="hidden"]):not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="image"]),select,textarea')].filter(visible);
      // A sign-in form has a username and possibly one tenant/domain field.
      if (fields.length > 2) return "reject";
      const username = fields.some((input) => /email|user|login|account|sign\s*in|member\s*id|customer\s*id/i.test(`${input.type} ${input.name} ${input.id} ${input.getAttribute("autocomplete") || ""} ${input.getAttribute("aria-label") || ""} ${input.getAttribute("placeholder") || ""} ${input.labels ? [...input.labels].map((label) => label.textContent).join(" ") : ""}`));
      const signIn = [...scope.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(visible)
        .some((element) => /\b(sign\s*in|log\s*in|login)\b/i.test(element.getAttribute("aria-label") || element.value || element.textContent || ""));
      return username || (!fields.length && signIn) ? "login" : "none";
    }).catch(() => "none");
    if (verdict === "login") return true;
    if (verdict === "reject") return false;
  }
  return false;
}

// An application route that is not the configured login page or an obvious
// authentication route never receives credentials, even if it has a login form.
export function isAuthenticationRoute(pageUrl, config) {
  try {
    const current = new URL(pageUrl);
    if (config.targetUrl && current.origin !== new URL(config.targetUrl).origin) return true;
    if (config.login?.url && comparableUrl(pageUrl) === comparableUrl(config.login.url)) return true;
    return /(?:^|[/#._-])(?:log[-_]?in|sign[-_]?in|signon|sso|auth|authenticate|authorize|oauth2?|saml|openid|idp|cas|session[-_]?expired|reauth)(?:$|[/?#._-])/i.test(`${current.pathname}${current.hash}`);
  } catch {
    return false;
  }
}

async function aiControl(page, expectedAction, config, onEvent) {
  const result = await findLoginControlWithAI({ page, expectedAction, config, onEvent });
  if (result?.requiresUser) throw loginError(`User action required: ${result.message}`);
  return result?.locator && await usableAuthenticationControl(result.locator, expectedAction) ? result.locator : null;
}

async function resolveControl(page, selectors, expectedAction, config, onEvent, firstWait, secondWait) {
  let control = await waitForControl(page, selectors, firstWait, expectedAction);
  if (control) return control;
  control = await aiControl(page, expectedAction, config, onEvent);
  if (control) return control;
  if (secondWait > 0) control = await waitForControl(page, selectors, secondWait, expectedAction);
  if (control) return control;
  return aiControl(page, expectedAction, config, onEvent);
}

async function waitForControl(page, selectors, timeout, expectedAction) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const control = await findControl(page, selectors, expectedAction);
    if (control) return control;
    await page.waitForTimeout(250);
  }
  return null;
}

const USERNAME_LABEL = /\b(?:user(?:\s*name)?|e[-\s]?mail|login\s*(?:id|name)?|log[-\s]?in\s+id|sign[-\s]?in\s+(?:name|id)|account\s+(?:name|id|identifier)|member\s*(?:id|number)|customer\s*(?:id|number)|corporate\s+(?:id|identifier))\b/i;
const LOGIN_ENTRY_LABEL = /^\s*(?:log\s*in|sign\s*in|my\s+account|continue)(?:\b|\s|$)/i;
const AUTH_CONTINUE_LABEL = /^\s*(?:continue|next|log\s*in|sign\s*in|submit)(?:\b|\s|$)/i;

async function findControl(page, selectors, expectedAction) {
  // An explicit selector wins across frames. Generic semantic discovery follows
  // the configured selectors, and never requires a model or credentials.
  for (const selector of selectors.filter(Boolean)) {
    for (const frame of page.frames()) {
      try {
        const candidates = frame.locator(selector);
        const candidate = await firstUsableAuthenticationControl(candidates, expectedAction);
        if (candidate) return candidate;
      } catch {}
    }
  }
  for (const frame of page.frames()) {
    let candidates = [];
    if (expectedAction === "fill_username") {
      candidates = [frame.getByLabel(USERNAME_LABEL), frame.getByRole("textbox", { name: USERNAME_LABEL }), frame.getByPlaceholder(USERNAME_LABEL)];
    } else if (expectedAction === "fill_password") {
      candidates = [frame.getByLabel(/\bpassword\b/i)];
    } else if (["click_login_entry", "click_auth_continue"].includes(expectedAction)) {
      const name = expectedAction === "click_login_entry" ? LOGIN_ENTRY_LABEL : AUTH_CONTINUE_LABEL;
      candidates = [frame.getByRole("button", { name }), frame.getByRole("link", { name })];
    }
    for (const matches of candidates) {
      const candidate = await firstUsableAuthenticationControl(matches, expectedAction);
      if (candidate) return candidate;
    }
  }
  return null;
}

async function firstUsableAuthenticationControl(candidates, expectedAction) {
  const count = Math.min(await candidates.count().catch(() => 0), 30);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await usableAuthenticationControl(candidate, expectedAction)) return candidate;
  }
  return null;
}

async function usableAuthenticationControl(candidate, expectedAction) {
  if (!await candidate.isVisible().catch(() => false)) return false;
  // Outcome detection must still see a disabled password field while a provider
  // is submitting. Only discovery for an action requires enabled/editable.
  if (!expectedAction) return true;
  if (!await candidate.isEnabled().catch(() => false)) return false;
  const compatible = await candidate.evaluate((element, action) => {
    const tag = element.localName;
    const type = String(element.getAttribute("type") || (tag === "input" ? "text" : "")).toLowerCase();
    if (action === "fill_password") return tag === "input" && type === "password" && element.autocomplete !== "new-password";
    if (action === "fill_username") {
      const identity = [element.getAttribute("autocomplete"), element.getAttribute("name"), element.id,
        element.getAttribute("aria-label"), element.getAttribute("placeholder"),
        ...[...(element.labels || [])].map((label) => label.textContent)].filter(Boolean).join(" ");
      if (/one[-\s]?time[-\s]?(?:code|password)|\b(?:otp|captcha|verification\s+code|security\s+code)\b/i.test(identity)) return false;
      return (tag === "input" && ["text", "email", "tel", "number", "search", "url"].includes(type) || tag === "textarea" || element.isContentEditable)
        && element.autocomplete !== "new-password";
    }
    if (["click_login_entry", "click_auth_continue"].includes(action)) {
      if (!["button", "a"].includes(tag) && element.getAttribute("role") !== "button" && !(tag === "input" && ["button", "submit", "image"].includes(type))) return false;
      // Read a submit button's label, never the value of a credential input.
      const label = `${element.getAttribute("aria-label") || ""} ${tag === "input" ? element.getAttribute("value") || "" : element.textContent || ""}`;
      return !/\b(?:sign\s*up|register|registration|create\s+(?:an?\s+)?account|forgot\s+(?:your\s+)?password|reset\s+(?:your\s+)?password|delete|remove|purchase|pay(?:ment)?|transfer|trade|buy|sell|place\s+order|submit\s+order|log\s*out|sign\s*out)\b/i.test(label);
    }
    return true;
  }, expectedAction).catch(() => false);
  return compatible && (!String(expectedAction).startsWith("fill_") || await candidate.isEditable().catch(() => false));
}

async function visibleLoginError(page) {
  const selectors = ['[role="alert"]:visible', '.error:visible', '.error-message:visible', '[aria-live="assertive"]:visible'];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const message = await frame.locator(selector).first().textContent({ timeout: 500 }).catch(() => "");
      if (message?.trim()) return message.trim().slice(0, 300);
    }
  }
  return "";
}

function loginError(message) {
  const error = new Error(message);
  error.code = "LOGIN_FAILED";
  return error;
}

async function waitForOrigin(page, expectedOrigin, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (safeOrigin(page.url()) === expectedOrigin) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

function safeOrigin(value) {
  try { return new URL(value).origin; } catch { return null; }
}

async function waitForAuthenticationOutcome(page, config, timeout) {
  const deadline = Date.now() + timeout;
  const targetOrigin = safeOrigin(config.targetUrl);
  while (Date.now() < deadline) {
    const message = await visibleLoginError(page);
    if (message) return { status: "error", message };
    const password = await findControl(page, [config.login.passwordSelector, 'input[type="password"]']);
    if (!password) {
      const challenge = await detectSecurityChallenge(page);
      if (challenge) return { status: "challenge", message: challenge };
      if (targetOrigin && safeOrigin(page.url()) === targetOrigin && comparableUrl(page.url()) !== comparableUrl(config.login.url)) return { status: "callback" };
      return { status: "advanced" };
    }
    await page.waitForTimeout(500);
  }
  return { status: "timeout" };
}

async function isAuthenticatedDestination(page, config) {
  if (safeOrigin(page.url()) !== safeOrigin(config.targetUrl)) return false;
  if (await isLoginSurface(page)) return false;
  const current = comparableUrl(page.url());
  const login = comparableUrl(config.login.url);
  if (current && login && current !== login) return true;
  return page.frames().some((frame) => frame === page.mainFrame()) && page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 2 && rect.height >= 2;
    };
    return [...document.querySelectorAll('a,button,[role="button"],[role="link"]')].some((element) => {
      if (!visible(element)) return false;
      const label = (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim();
      return /\b(log\s*out|sign\s*out|profile|my\s+account|dashboard)\b/i.test(label);
    });
  }).catch(() => false);
}

function comparableUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return `${url.origin}${url.pathname.replace(/\/$/, "") || "/"}`;
  } catch {
    return null;
  }
}

export function scopedAuthStatePath(basePath, targetUrl) {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
    const extension = path.extname(basePath) || ".json";
    const stem = path.basename(basePath, extension);
    return path.join(path.dirname(basePath), `${stem}.${host}${extension}`);
  } catch {
    return basePath;
  }
}
