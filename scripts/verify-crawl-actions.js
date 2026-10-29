import assert from "node:assert/strict";
import { chromium } from "playwright";
import { discoverNavigationActions } from "../src/scanner/discovery.js";
import { inventorySafeActions } from "../src/scanner/actions.js";
import { scanKeyboardFocus } from "../src/scanner/focus.js";
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

  await page.setContent(`
    <a href="https://application.test/logout">Exit session</a>
    <a href="https://application.test/setting">Deactivate account</a>
    <a href="https://application.test/provider">Excluded provider</a>
    <a href="https://application.test/reports">Open reports</a>
    <button>View details</button>
    <form id="edit"><button>Continue</button></form>
    <button form="edit">Next</button>
    <form><button><span role="button">Continue nested submission</span></button></form>
    <label><input type="checkbox"><span role="button">Open preference switch</span></label>
    <div role="switch"><span role="button">View switch preference</span></div>
    <button disabled><span role="button">View disabled details</span></button>
  `);
  const safeRoutes = await discoverNavigationActions(page, "https://application.test/", { excludeLabels: ["Excluded provider"] });
  assert.deepEqual(safeRoutes.map((action) => action.label), ["Open reports"], "URL discovery must apply the same safety and exclusion policy as clicking");
  const safeControls = await inventorySafeActions(page);
  assert.ok(safeControls.some((action) => action.label === "View details"), "a button with default type outside any form does not submit a form");
  assert.equal(safeControls.some((action) => ["Continue", "Next", "Deactivate account", "Exit session"].includes(action.label)), false);
  assert.equal(safeControls.some((action) => /nested submission|preference switch|switch preference|disabled details/.test(action.label)), false, "child spans must not bypass form/control restrictions");

  await page.setContent('<style>button:focus{outline:none;box-shadow:none}</style><h1>Focus paths</h1><section><button>First</button></section><section><button>Second</button></section>');
  const focusFindings = await scanKeyboardFocus(page, "https://application.test/", 6);
  assert.equal(focusFindings.length, 2, "same-tag controls in different parents must not prematurely stop focus traversal");
  assert.equal(new Set(focusFindings.map((finding) => JSON.stringify(finding.target))).size, 2);
  for (const finding of focusFindings) assert.equal(await page.locator(finding.target[0]).count(), 1, "focus targets must uniquely resolve to the observed element");

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
