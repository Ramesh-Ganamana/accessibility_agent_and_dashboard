import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { detectSecurityChallenge, findLoginControlWithAI } from "./ai-login.js";
import { hasVisibleBusyState, navigateAndWait, waitForPageReady } from "./readiness.js";
import { resolvePostLoginObstructions, waitForPostLoginObstruction } from "./post-login.js";

export async function createBrowserSession(config, onEvent = () => {}) {
  const browser = await launchCompatibleBrowser(config, onEvent);
  const authStatePath = scopedAuthStatePath(config.authStatePath, config.targetUrl || config.login?.url);
  const contextOptions = {
    viewport: { width: 1440, height: 960 },
    reducedMotion: "reduce",
    locale: "en-US",
    colorScheme: "light",
    ignoreHTTPSErrors: true
  };

  const loadedStorage = Boolean(config.login.persist && fs.existsSync(authStatePath));
  if (loadedStorage) {
    contextOptions.storageState = authStatePath;
    onEvent({ type: "session", message: "Loaded the persisted session for this application." });
  }

  const context = await browser.newContext(contextOptions);
  const popupPages = new Set();

  const page = await context.newPage();
  wirePage(page, onEvent);

  context.on("page", (popup) => {
    if (popup === page) return;
    popupPages.add(popup);
    wirePage(popup, onEvent);
    onEvent({ type: "popup", message: "Detected a new browser window or popup.", url: popup.url() });
  });

  return {
    browser,
    context,
    page,
    popupPages,
    loadedStorage,
    authStatePath,
    async persist() {
      await context.storageState({ path: authStatePath });
    },
    async close() {
      await context.close();
      await browser.close();
    }
  };
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

function wirePage(page, onEvent) {
  page.on("dialog", async (dialog) => {
    onEvent({
      type: "dialog",
      message: `Handled ${dialog.type()} dialog: ${dialog.message()}`,
      url: page.url()
    });
    await dialog.dismiss().catch(() => {});
  });

  page.on("pageerror", (error) => {
    onEvent({ type: "page-error", message: error.message, url: page.url() });
  });
}

export async function ensureAuthenticated(session, config, onEvent = () => {}, options = {}) {
  if (!config.login.url || !config.login.email || !config.login.password) return false;

  const page = session.page;
  if (options.useCurrentPage) await waitForPageReady(page, { timeout: 60_000, shellWaitMs: 300_000, settleMs: 700 });
  else await navigateAndWait(page, config.login.url, { timeout: 60_000, shellWaitMs: 300_000, settleMs: 700 });

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
  let username = await waitForControl(page, usernameSelectors, 3_000);
  if (!username) username = await aiControl(page, "fill_username", config, onEvent);
  if (!username) username = await waitForControl(page, usernameSelectors, 8_000);

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
        entry.click()
      ]);
      await waitForPageReady(page, { timeout: 25_000, settleMs: 700 });
    }
    username = await resolveControl(page, usernameSelectors, "fill_username", config, onEvent, 15_000, 20_000);
  }
  if (!username) {
    throw loginError("Username field was not found after redirects. Open Advanced login selectors and provide the username field selector.");
  }
  await username.fill(config.login.email);

  let password = await resolveControl(page, [config.login.passwordSelector, 'input[type="password"]'], "fill_password", config, onEvent, 1_200, 500);
  if (!password) {
    let next = await resolveControl(page, [config.login.submitSelector, '#continue, #next, button[type="submit"], input[type="submit"], [role="button"][aria-label*="continue" i], [role="button"][aria-label*="next" i], [role="button"][aria-label*="sign in" i]'], "click_auth_continue", config, onEvent, 2_000, 3_000);
    if (!next) throw loginError("The username was filled, but a Continue/Next button was not found.");
    onEvent({ type: "session", message: "Username submitted; waiting for the password stage." });
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {}),
      next.click()
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
  await password.fill(config.login.password);

  let submit = await resolveControl(page, [config.login.submitSelector, '#signIn, #continue, button[type="submit"], input[type="submit"], [role="button"][aria-label*="sign in" i], [role="button"][aria-label*="login" i], [role="button"][aria-label*="log in" i], [role="button"][aria-label*="submit" i]'], "click_auth_continue", config, onEvent, 2_000, 3_000);
  if (!submit) throw loginError("Password was filled, but the final sign-in button was not found.");
  onEvent({ type: "session", message: "Submitting the password and waiting for the application callback." });
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {}),
    submit.click()
  ]);
  const authOutcome = await waitForAuthenticationOutcome(page, config, 45_000);
  if (authOutcome.status === "error") throw loginError(authOutcome.message);
  if (authOutcome.status === "challenge") throw loginError(`User action required: complete the ${authOutcome.message}, then retry the scan.`);
  if (authOutcome.status === "timeout") {
    throw loginError("The identity provider did not accept or redirect the password stage within 45 seconds. Verify the credentials and check the provider message shown on the login page.");
  }
  await waitForPageReady(page, { timeout: 60_000, shellWaitMs: 300_000, settleMs: 900 });

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
    await waitForPageReady(page, { timeout: 30_000, shellWaitMs: 300_000, settleMs: 900 });
  }
  if (await waitForPostLoginObstruction(page)) {
    onEvent({ type: "post-login", message: "A blocking post-login dialog appeared; inspecting it now.", url: page.url() });
    await resolvePostLoginObstructions(page, config, onEvent);
  }
  if (config.login.persist) {
    await session.persist();
    onEvent({ type: "session", message: "Login completed and the local browser session was refreshed." });
  } else {
    onEvent({ type: "session", message: "Login completed for this scan only; the session was not saved." });
  }
  return true;
}

export async function isLoginSurface(page) {
  const password = await findControl(page, ['input[type="password"], input[autocomplete="current-password"]']);
  if (!password) return false;
  const username = await findControl(page, ['input[type="email"], input[autocomplete="username"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]']);
  if (username) return true;
  for (const frame of page.frames()) {
    const hasSignInAction = await frame.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 2 && rect.height >= 2;
      };
      return [...document.querySelectorAll('button,input[type="submit"],[role="button"]')].some((element) => {
        if (!visible(element)) return false;
        const label = (element.getAttribute("aria-label") || element.value || element.textContent || "").replace(/\s+/g, " ").trim();
        return /\b(sign\s*in|log\s*in|login)\b/i.test(label);
      });
    }).catch(() => false);
    if (hasSignInAction) return true;
  }
  return false;
}

async function aiControl(page, expectedAction, config, onEvent) {
  const result = await findLoginControlWithAI({ page, expectedAction, config, onEvent });
  if (result?.requiresUser) throw loginError(`User action required: ${result.message}`);
  return result?.locator || null;
}

async function resolveControl(page, selectors, expectedAction, config, onEvent, firstWait, secondWait) {
  let control = await waitForControl(page, selectors, firstWait);
  if (control) return control;
  control = await aiControl(page, expectedAction, config, onEvent);
  if (control) return control;
  if (secondWait > 0) control = await waitForControl(page, selectors, secondWait);
  if (control) return control;
  return aiControl(page, expectedAction, config, onEvent);
}

async function waitForControl(page, selectors, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const control = await findControl(page, selectors);
    if (control) return control;
    await page.waitForTimeout(250);
  }
  return null;
}

async function findControl(page, selectors) {
  for (const frame of page.frames()) {
    for (const selector of selectors.filter(Boolean)) {
      try {
        const candidates = frame.locator(selector);
        const count = Math.min(await candidates.count(), 8);
        for (let index = 0; index < count; index += 1) {
          const candidate = candidates.nth(index);
          if (await candidate.isVisible({ timeout: 250 }).catch(() => false)) return candidate;
        }
      } catch {}
    }
  }
  return null;
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
