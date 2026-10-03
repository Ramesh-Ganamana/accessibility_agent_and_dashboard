import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback) => {
  if (value == null || value === "") return fallback;
  return String(value).toLowerCase() !== "false";
};

const toList = (value) => (Array.isArray(value) ? value : String(value || "").split(/[\n,]/))
  .map((item) => String(item).replace(/\s+/g, " ").trim())
  .filter(Boolean)
  .slice(0, 100);

const toOrigin = (value) => {
  try { return new URL(value).origin; } catch { return ""; }
};

export function getConfig(overrides = {}) {
  const loginOverride = overrides.login;
  const loginDisabled = loginOverride === false;
  const loginValue = (key, environmentValue, fallback = "") => {
    if (loginDisabled) return fallback;
    if (loginOverride && Object.hasOwn(loginOverride, key)) return loginOverride[key];
    return environmentValue || fallback;
  };
  return {
    rootDir,
    reportsDir: path.join(rootDir, "reports"),
    authStatePath: path.join(rootDir, "auth_state.json"),
    port: toInt(process.env.PORT, 4173),
    targetUrl: overrides.targetUrl || process.env.TARGET_URL || "",
    maxPages: Number(overrides.maxPages ?? toInt(process.env.MAX_PAGES, 25)),
    maxDepth: Number(overrides.maxDepth ?? toInt(process.env.MAX_DEPTH, 3)),
    headless: overrides.headless ?? toBool(process.env.HEADLESS, true),
    browserChannel: overrides.browserChannel || process.env.BROWSER_CHANNEL || "bundled",
    aiEnabled: overrides.aiEnabled ?? Boolean(process.env.OPENAI_API_KEY),
    aiCrawlerStallMs: Number(overrides.aiCrawlerStallMs ?? toInt(process.env.AI_CRAWLER_STALL_MS, 50_000)),
    aiGroundingChooser: overrides.aiGroundingChooser,
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    openAiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
    excludeActionLabels: toList(overrides.excludeActionLabels ?? process.env.EXCLUDE_ACTION_LABELS),
    excludeActionOrigin: toOrigin(overrides.excludeActionOrigin || overrides.targetUrl || process.env.TARGET_URL),
    login: {
      url: loginValue("url", process.env.LOGIN_URL),
      email: loginValue("username", process.env.LOGIN_EMAIL),
      password: loginValue("password", process.env.LOGIN_PASSWORD),
      persist: loginDisabled ? true : loginOverride?.persist ?? true,
      aiEnabled: loginDisabled ? false : Boolean(loginOverride?.aiEnabled),
      postLoginValue: loginValue("postLoginValue", process.env.POST_LOGIN_VALUE),
      emailSelector: loginValue("emailSelector", process.env.EMAIL_SELECTOR, '#signInName, input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]'),
      passwordSelector: loginValue("passwordSelector", process.env.PASSWORD_SELECTOR, 'input[type="password"], input[autocomplete="current-password"]'),
      submitSelector: loginValue("submitSelector", process.env.SUBMIT_SELECTOR, '#continue, #next, #signIn, button[type="submit"], input[type="submit"]')
    },
    excludePaths: (process.env.EXCLUDE_PATHS || "/logout,/signout,/delete,/remove")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  };
}
