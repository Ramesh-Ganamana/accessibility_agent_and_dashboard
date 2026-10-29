import assert from "node:assert/strict";
import { chromium } from "playwright";
import { inspectBlockingObstruction, resolveBlockingObstruction } from "../src/browser/blockers.js";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.setContent(documentWith(`
    <div id="backdrop" class="screen-overlay"></div>
    <section id="login-modal" role="dialog" aria-modal="true">
      <h2>Sign in for offers</h2>
      <label>Phone <input id="phone" value="existing-value"></label>
      <button id="close" aria-label="Close">×</button>
    </section>
    <script>document.querySelector('#close').onclick=()=>{document.querySelector('#login-modal').hidden=true;document.querySelector('#backdrop').hidden=true}</script>
  `));
  const detected = await inspectBlockingObstruction(page);
  assert.equal(detected.title, "Sign in for offers");
  assert.equal(detected.inputCount, 1);
  const closed = await resolveBlockingObstruction(page);
  assert.equal(closed.handled, true);
  assert.equal(closed.method, "control");
  assert.equal(await page.locator("#phone").inputValue(), "existing-value", "blocker recovery must never edit an existing dialog input");
  assert.equal(await page.locator("#login-modal").isVisible(), false);

  await page.setContent(documentWith(`
    <section id="ordered-modal" role="dialog" aria-modal="true">
      <h2>Optional offer</h2>
      <button onclick="document.body.dataset.clicked='skip'">Skip</button>
      <button onclick="document.body.dataset.clicked='cancel'">Cancel</button>
      <button onclick="document.body.dataset.clicked='close'" aria-label="Close">×</button>
    </section>
    <script>document.querySelectorAll('#ordered-modal button').forEach((button)=>button.addEventListener('click',()=>document.querySelector('#ordered-modal').hidden=true))</script>
  `));
  const ordered = await resolveBlockingObstruction(page);
  assert.equal(ordered.handled, true);
  assert.equal(ordered.control, "Close", "Close/X must be preferred over Cancel and Skip regardless of DOM order");
  assert.equal(await page.locator("body").getAttribute("data-clicked"), "close");

  await page.setContent(documentWith(`
    <section id="cancel-modal" role="dialog" aria-modal="true">
      <h2>Optional survey</h2>
      <button onclick="document.body.dataset.clicked='skip';this.parentElement.hidden=true">Skip</button>
      <button onclick="document.body.dataset.clicked='cancel';this.parentElement.hidden=true">Cancel</button>
    </section>
  `));
  const cancelled = await resolveBlockingObstruction(page);
  assert.equal(cancelled.control, "Cancel", "Cancel must be preferred over Skip when no Close/X control exists");
  assert.equal(await page.locator("body").getAttribute("data-clicked"), "cancel");

  await page.setContent(documentWith(`
    <div id="escape-modal" role="dialog" aria-modal="true"><h2>Announcement</h2></div>
    <script>addEventListener('keydown',(event)=>{if(event.key==='Escape')document.querySelector('#escape-modal').hidden=true})</script>
  `));
  const escaped = await resolveBlockingObstruction(page);
  assert.equal(escaped.handled, true);
  assert.equal(escaped.method, "escape");

  await page.setContent(documentWith('<section id="ordinary" role="dialog"><h2>Inline account details</h2><input value="keep-me"></section>'));
  assert.equal(await inspectBlockingObstruction(page), null, "an inline non-modal dialog must not trigger blocker recovery");
  assert.equal(await page.locator("#ordinary input").inputValue(), "keep-me");

  await page.setContent(documentWith('<section id="required" role="dialog" aria-modal="true"><h2>Enter verification code</h2><input value="123456"></section>'));
  const required = await resolveBlockingObstruction(page);
  assert.equal(required.handled, false);
  assert.equal(required.requiresUser, true);
  assert.equal(required.reason, "security_challenge_requires_user");
  assert.equal(await page.locator("#required input").inputValue(), "123456");

  await page.setContent(documentWith('<section id="restore-modal" role="dialog" aria-modal="true"><h2>Choose a value</h2></section>'));
  const restored = await resolveBlockingObstruction(page, {
    restore: async () => {
      await page.locator("#restore-modal").evaluate((element) => { element.hidden = true; });
      return true;
    }
  });
  assert.equal(restored.handled, true);
  assert.equal(restored.method, "restore");

  await page.setContent(documentWith(`
    <section role="dialog" aria-modal="true"><h2>Background notice</h2><button aria-label="Close">×</button></section>
    <section id="top-dialog" role="dialog" aria-modal="true" style="z-index:20"><h2>Top notice</h2><button aria-label="Close" onclick="this.parentElement.hidden=true">×</button></section>
  `));
  const topClosed = await resolveBlockingObstruction(page);
  assert.equal(topClosed.handled, true, "the top dialog must use its own Close control, not another dialog's identically numbered key");
  assert.equal(await page.locator("#top-dialog").isVisible(), false);

  await page.setContent(documentWith(`
    <section id="still-open" role="dialog" aria-modal="true"><h2>Required action</h2>
      <button aria-label="Close" onclick="this.previousElementSibling.textContent='Please finish the required action'">×</button>
    </section>
  `));
  const stillOpen = await resolveBlockingObstruction(page);
  assert.equal(stillOpen.handled, false, "changed dialog text must not be mistaken for a dismissed blocker");
  assert.equal(stillOpen.requiresUser, true);
  assert.equal(await page.locator("#still-open").isVisible(), true);

  console.log("Universal blocker detection, safe close order, Escape, restore, and input preservation passed.");
} finally {
  await browser.close();
}

function documentWith(content) {
  return `<!doctype html><html><head><style>
    body{margin:0;min-height:100vh} main{padding:30px}.screen-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45)}
    [aria-modal="true"]{position:fixed;z-index:10;inset:20% 25%;background:white;padding:20px}
  </style></head><body><main><h1>Application</h1><button>Underlying action</button>${content}</main></body></html>`;
}
