import assert from "node:assert/strict";
import { chromium } from "playwright";
import { discoverNavigationActions } from "../src/scanner/discovery.js";
import { hasVisibleBusyState, isPageVisiblyReady, waitForPageReady } from "../src/browser/readiness.js";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`
    <a id="reports" href="https://application.test/reports">Employee reports</a>
    <a href="https://application.test/help" target="_blank" aria-label="Open help center">Help</a>
    <state-navigation></state-navigation>
  `);
  await page.evaluate(() => {
    const host = document.querySelector("state-navigation");
    host.attachShadow({ mode: "open" }).innerHTML = '<a href="https://application.test/profile">My profile</a>';
  });

  const actions = await discoverNavigationActions(page, "https://application.test/");
  assert.ok(actions.some((action) => action.url === "https://application.test/reports" && action.label === "Employee reports"));
  assert.ok(actions.some((action) => action.url === "https://application.test/help" && action.popup));
  assert.ok(actions.some((action) => action.url === "https://application.test/profile" && action.label === "My profile"));

  await page.setContent('<div class="application-loading"><span>Loading..</span></div><main hidden><h1>Ready</h1></main><script>setTimeout(() => { document.querySelector(".application-loading").remove(); document.querySelector("main").hidden = false; }, 700)</script>');
  const started = Date.now();
  await waitForPageReady(page, { timeout: 5_000, settleMs: 200 });
  assert.ok(Date.now() - started >= 600, "readiness should wait for a visible loading screen to disappear");
  assert.equal(await page.locator("h1").textContent(), "Ready");

  await page.setContent('<div class="small-spinner">Loading...</div><main><h1>Rewards dashboard</h1><p>Your account and rewards are ready to use.</p><button>My rewards</button><button>My card</button></main>');
  assert.equal(await hasVisibleBusyState(page), false, "a small spinner must not block a visibly usable page");
  assert.equal(await isPageVisiblyReady(page), true, "visible application content should determine readiness");

  await page.setContent('<header><a href="#">Login</a></header><main style="min-height:300px"></main>');
  const shellStarted = Date.now();
  const shellReady = await waitForPageReady(page, { timeout: 150, shellWaitMs: 600, settleMs: 50 });
  const shellElapsed = Date.now() - shellStarted;
  assert.equal(shellReady, false, "an empty application shell should remain unready at its configured ceiling");
  assert.ok(shellElapsed >= 500 && shellElapsed < 2_000, "the shell ceiling should be bounded and independently configurable");
  console.log("Navigation discovery and visibility-based readiness passed.");
} finally {
  await browser.close();
}
