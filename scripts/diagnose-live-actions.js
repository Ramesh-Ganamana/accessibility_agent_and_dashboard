import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { clickSafeAction, inventorySafeActions } from "../src/scanner/actions.js";
import { navigateAndWait } from "../src/browser/readiness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storageState = path.join(root, "auth_state.json");
const targetUrl = process.argv[2] || "https://app.qa.sunnybenefits.com/";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    ...(fs.existsSync(storageState) ? { storageState } : {})
  });
  const page = await context.newPage();
  await navigateAndWait(page, targetUrl, { timeout: 60_000, settleMs: 1_000 });
  const raw = [];
  for (const [frameIndex, frame] of page.frames().entries()) {
    const entries = await frame.evaluate(() => [...document.querySelectorAll('button,[role="button"],[role="link"],[role="tab"],[onclick],[tabindex]:not([tabindex="-1"])')].slice(0, 80).map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.localName,
        typeAttribute: element.getAttribute("type"),
        typeProperty: element.type,
        role: element.getAttribute("role"),
        label: (element.getAttribute("aria-label") || element.textContent || element.value || "").replace(/\s+/g, " ").trim().slice(0, 80),
        visible: style.display !== "none" && style.visibility !== "hidden" && rect.width >= 2 && rect.height >= 2,
        disabled: element.matches(":disabled,[aria-disabled='true']"),
        inForm: Boolean(element.closest("form")),
        cursor: style.cursor
      };
    })).catch((error) => [{ evaluationError: error.message }]);
    raw.push({ frameIndex, framePath: safePath(frame.url()), entries });
  }
  const safe = await inventorySafeActions(page);
  let afterFirstAction = null;
  if (process.argv.includes("--click-first") && safe[0]) {
    const result = await clickSafeAction(page, safe[0]);
    const nextActions = await inventorySafeActions(page, { attempts: 2 });
    afterFirstAction = { clicked: result.clicked, pagePath: safePath(page.url()), controls: nextActions.map((action) => action.label).slice(0, 30) };
  }
  console.log(JSON.stringify({ pagePath: safePath(page.url()), title: await page.title(), raw, safe: safe.map(({ label, tag, role, type, path: controlPath }) => ({ label, tag, role, type, path: controlPath })), afterFirstAction }, null, 2));
  await context.close();
} finally {
  await browser.close();
}

function safePath(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "unknown"; }
}
