import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseActionExclusions } from "./browser/action-exclusions.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const boundedInteger = (value, fallback, minimum, maximum) => {
  if (value == null || String(value).trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.trunc(number))) : fallback;
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
  const nvdaOverride = overrides.nvda || {};
  const loginDisabled = loginOverride === false;
  const loginValue = (key, environmentValue, fallback = "") => {
    if (loginDisabled) return fallback;
    if (loginOverride && Object.hasOwn(loginOverride, key)) return loginOverride[key];
    return environmentValue || fallback;
  };
  return {
    rootDir,
    reportsDir: path.join(rootDir, "reports"),
    // Saved sessions contain live cookies. Keep them out of the project folder so
    // zipping or sharing the workspace cannot leak them.
    authStatePath: path.join(path.resolve(process.env.AUTH_STATE_DIR || path.join(process.env.LOCALAPPDATA || path.join(rootDir, ".sessions"), "RAMBO", "sessions")), "auth_state.json"),
    legacyAuthStatePath: path.join(rootDir, "auth_state.json"),
    // null = decide per scan: ignore certificate errors only when no credentials are typed.
    ignoreHttpsErrors: overrides.ignoreHttpsErrors ?? (process.env.IGNORE_HTTPS_ERRORS ? toBool(process.env.IGNORE_HTTPS_ERRORS, false) : null),
    scanThirdPartyFrames: overrides.scanThirdPartyFrames ?? toBool(process.env.SCAN_THIRD_PARTY_FRAMES, false),
    appShellWaitMs: boundedInteger(overrides.appShellWaitMs ?? process.env.APP_SHELL_WAIT_MS, 90_000, 0, 600_000),
    // Tab stops per page; unreachable-control checks need a complete traversal.
    // "mobile" emulates a Pixel 7 in Chromium (viewport, touch, mobile user
    // agent). It is a responsive-layout check, not a real-device test.
    device: ["desktop", "mobile"].includes(overrides.device ?? process.env.SCAN_DEVICE) ? (overrides.device ?? process.env.SCAN_DEVICE) : "desktop",
    keyboardMaxTabs: boundedInteger(overrides.keyboardMaxTabs ?? process.env.KEYBOARD_MAX_TABS, 120, 10, 500),
    // Same-site PDFs checked per scan (0 turns document checks off).
    documentsMax: boundedInteger(overrides.documentsMax ?? process.env.DOCUMENTS_MAX, 10, 0, 100),
    port: toInt(process.env.PORT, 4173),
    targetUrl: overrides.targetUrl || process.env.TARGET_URL || "",
    maxPages: boundedInteger(overrides.maxPages ?? process.env.MAX_PAGES, 25, 1, 100),
    maxStates: boundedInteger(overrides.maxStates ?? process.env.MAX_STATES, 100, 1, 500),
    maxDepth: boundedInteger(overrides.maxDepth ?? process.env.MAX_DEPTH, 3, 0, 8),
    headless: overrides.headless ?? toBool(process.env.HEADLESS, true),
    browserChannel: overrides.browserChannel || process.env.BROWSER_CHANNEL || "bundled",
    audit: {
      profile: overrides.audit?.profile === "financial" ? "financial" : "general",
      wcagVersion: overrides.audit?.wcagVersion === "2.1" ? "2.1" : "2.2",
      level: "AA"
    },
    nvda: {
      allowed: nvdaOverride.allowed ?? toBool(process.env.NVDA_ENABLED, false),
      requested: Boolean(nvdaOverride.requested),
      executable: nvdaOverride.executable || process.env.NVDA_PATH || "",
      configPath: path.resolve(nvdaOverride.configPath || process.env.NVDA_CONFIG_PATH || path.join(process.env.LOCALAPPDATA || rootDir, "RAMBO", "nvda-profile")),
      maxStates: boundedInteger(nvdaOverride.maxStates ?? process.env.NVDA_MAX_STATES, 100, 1, 500),
      // Test the live state before the crawler leaves it. Historical replay
      // remains an explicit opt-in, never the fallback for a missing setting.
      mode: (nvdaOverride.mode ?? process.env.NVDA_MODE) === "after-crawl" ? "after-crawl" : "during-crawl",
      tests: [...new Set(toList(nvdaOverride.tests ?? process.env.NVDA_TESTS ?? "focus,reading,headings,tables"))].filter((test) => ["focus", "reading", "headings", "tables"].includes(test)),
      readingTimeoutMs: boundedInteger(nvdaOverride.readingTimeoutMs ?? process.env.NVDA_READING_TIMEOUT_MS, 300000, 1000, 1800000),
      headingStops: boundedInteger(nvdaOverride.headingStops ?? process.env.NVDA_HEADING_STOPS, 3, 1, 10),
      tableStops: boundedInteger(nvdaOverride.tableStops ?? process.env.NVDA_TABLE_STOPS, 3, 1, 10),
      tabStops: Number(nvdaOverride.tabStops ?? toInt(process.env.NVDA_TAB_STOPS, 12)),
      startupTimeoutMs: boundedInteger(nvdaOverride.startupTimeoutMs ?? process.env.NVDA_STARTUP_TIMEOUT_MS, 60_000, 1000, 300_000),
      announcementWaitMs: Number(nvdaOverride.announcementWaitMs ?? toInt(process.env.NVDA_ANNOUNCEMENT_WAIT_MS, 650)),
      // Stop waiting this long after a key when NVDA has said nothing at all.
      // 0 keeps the full wait (about 2 s); 800-1200 shortens silent stops.
      silentWaitMs: boundedInteger(nvdaOverride.silentWaitMs ?? process.env.NVDA_SILENT_WAIT_MS, 0, 0, 4000),
      // Speech capture waits separately; this is only the pause after the key.
      keyDelayMs: Number(nvdaOverride.keyDelayMs ?? toInt(process.env.NVDA_KEY_DELAY_MS, 100)),
      // Human-readable speech is the default; maximum-rate capture is opt-in.
      fastSpeech: nvdaOverride.fastSpeech ?? toBool(process.env.NVDA_FAST_SPEECH, false),
      speechRate: boundedInteger(nvdaOverride.speechRate ?? process.env.NVDA_SPEECH_RATE, 40, 0, 100),
      // "review": screenshot only stops that need review; "all": every stop.
      actionScreenshots: (nvdaOverride.actionScreenshots ?? process.env.NVDA_ACTION_SCREENSHOTS) === "all" ? "all" : "review",
      // NVDA pauses when focus leaves the test tab and resumes when the agent
      // brings it back. Departures the agent caused do not count toward the limit.
      maxRecoveries: boundedInteger(nvdaOverride.maxRecoveries ?? process.env.NVDA_MAX_RECOVERIES, 3, 0, 10),
      maxPauseMs: boundedInteger(nvdaOverride.maxPauseMs ?? process.env.NVDA_MAX_PAUSE_MS, 120_000, 10_000, 600_000)
    },
    nvdaRunner: overrides.nvdaRunner,
    nvdaSessionFactory: overrides.nvdaSessionFactory,
    // Page screenshots and DOM metadata leave the machine when AI runs, so it is
    // never enabled just because an API key exists.
    aiEnabled: overrides.aiEnabled ?? (toBool(process.env.AI_ENABLED, false) && Boolean(process.env.OPENAI_API_KEY)),
    aiCrawlerStallMs: Number(overrides.aiCrawlerStallMs ?? toInt(process.env.AI_CRAWLER_STALL_MS, 5_000)),
    aiGroundingChooser: overrides.aiGroundingChooser,
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    openAiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
    excludeActionLabels: parseActionExclusions(overrides.excludeActionLabels ?? process.env.EXCLUDE_ACTION_LABELS),
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
