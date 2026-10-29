import assert from "node:assert/strict";
import { chromium } from "playwright";
import { isLoginSurface } from "../src/browser/session.js";
import { resolveContextChooserIfPresent } from "../src/browser/post-login.js";
import { waitForPageReady } from "../src/browser/readiness.js";
import { scanKeyboardFocus } from "../src/scanner/focus.js";
import { captureApplicationState, clickSafeAction, inventorySafeActions } from "../src/scanner/actions.js";

// Local synthetic pages only: no network, credentials, AI, NVDA or saved sessions.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();

  await page.setContent('<form><h1>Sign in</h1><label for="u">Email</label><input id="u" type="email"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password"><button>Sign in</button></form>');
  assert.equal(await isLoginSurface(page), true, "a plain sign-in form is a login surface");
  for (const [name, html] of [
    ["registration", '<form><h1>Create your account</h1><input type="email" aria-label="Email"><input type="password" aria-label="Password"><input type="password" aria-label="Confirm password"><button>Sign up</button></form>'],
    ["add-user dialog", '<div role="dialog" aria-modal="true"><h2>Add user</h2><label>Name <input></label><label>Email <input type="email"></label><label>Password <input type="password"></label><button>Save</button></div>'],
    ["new-password field", '<form><h1>Welcome</h1><input type="email" aria-label="Email"><input type="password" autocomplete="new-password"><button>Continue</button></form>'],
    ["profile form", '<form><h2>Profile</h2><label>Email <input type="email"></label><label>Current password <input type="password"></label><button>Update</button></form>']
  ]) {
    await page.setContent(html);
    assert.equal(await isLoginSurface(page), false, `${name} must never receive the tester's credentials`);
  }

  await page.setContent('<div role="dialog" aria-modal="true"><h2>Contact us</h2><label>Name <input id="name"></label><label>Company <input id="company"></label><textarea aria-label="Message"></textarea></div>');
  assert.equal((await resolveContextChooserIfPresent(page, { login: { postLoginValue: "" } })).handled, false, "a Company field in a contact form must not abort the crawl");
  assert.equal((await resolveContextChooserIfPresent(page, { login: { postLoginValue: "JCB" } })).handled, false);
  assert.equal(await page.locator("#company").inputValue(), "", "multi-field dialogs are never typed into");
  await page.setContent('<div role="dialog" aria-modal="true"><h2>Rename company</h2><label>Company name <input id="rename"></label><button>Save</button></div>');
  assert.equal((await resolveContextChooserIfPresent(page, { login: { postLoginValue: "JCB" } })).handled, false);
  assert.equal(await page.locator("#rename").inputValue(), "", "a single field that is not a picker is left alone during the crawl");
  await page.setContent('<div role="dialog" aria-modal="true" id="picker"><h2>Select a workspace</h2><input placeholder="Search workspace"><div onclick="document.querySelector(\'#picker\').remove(); document.body.dataset.workspace = \'JCB\'">JCB</div></div><main><h1>Dashboard</h1></main>');
  assert.equal((await resolveContextChooserIfPresent(page, { login: { postLoginValue: "JCB" } })).handled, true, "a real workspace picker is still handled during the crawl");
  assert.equal(await page.locator("body").getAttribute("data-workspace"), "JCB");

  await page.setContent('<style>body{margin:0}#corner{position:fixed;left:0;top:0;width:40px;height:40px}</style><a id="corner" href="#clicked" onclick="document.body.dataset.clicked=\'yes\'">Home</a><button>Plain</button>');
  await scanKeyboardFocus(page, "https://fixture.test/", 4);
  assert.equal(await page.evaluate(() => document.body.dataset.clicked || ""), "", "focus traversal must not click whatever sits at the page corner");

  await page.setContent('<style>.card{box-shadow:0 2px 8px #0004;padding:8px} button:focus{outline:none} #styled:focus-visible{background:#ffd400}</style><div class="card"><button id="hidden">No indicator</button></div><button id="styled">Background indicator</button>');
  const flagged = (await scanKeyboardFocus(page, "https://fixture.test/", 4)).map((finding) => finding.target.join(" "));
  assert.ok(flagged.some((target) => target.includes("#hidden")), "a card shadow must not hide a missing focus indicator");
  assert.ok(!flagged.some((target) => target.includes("#styled")), "a background-color focus style is a visible indicator");

  await page.setContent('<button id="details">View details</button><button>Löschen</button><button>Supprimer</button>');
  const actions = await inventorySafeActions(page, { attempts: 1 });
  assert.deepEqual(actions.map((action) => action.label), ["View details"], "non-English destructive buttons are excluded");
  await page.evaluate(() => { document.querySelector("#details").textContent = "Delete record"; });
  assert.equal((await clickSafeAction(page, actions[0], { readyTimeout: 2_000 })).clicked, false, "a control that became unsafe after inventory is never clicked");

  await page.setContent('<main><h1>Home</h1><div class="hero-carousel"><h2 id="slide">Slide 1</h2></div><p id="age">Updated 5 minutes ago</p></main>');
  const first = await captureApplicationState(page);
  await page.evaluate(() => { document.querySelector("#slide").textContent = "Slide 2"; document.querySelector("#age").textContent = "Updated 6 minutes ago"; });
  assert.equal((await captureApplicationState(page)).fingerprint, first.fingerprint, "carousel text and changing numbers are not a new application state");
  await page.evaluate(() => { document.querySelector("h1").textContent = "Account settings"; });
  assert.notEqual((await captureApplicationState(page)).fingerprint, first.fingerprint, "real content changes are still detected");

  await page.setContent('<main><h1>Dashboard</h1><p>Ready to use with several controls.</p><button>One</button><button>Two</button><div class="ticker" id="t"></div></main><script>setInterval(() => { const t = document.querySelector("#t"); t.className = "ticker tick-" + (Date.now() % 7); t.textContent = String(Date.now()); }, 50)</script>');
  const started = Date.now();
  await waitForPageReady(page, { timeout: 10_000, settleMs: 700 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_500, `a ticking widget must not hold readiness for the full settle cap (${elapsed} ms)`);

  console.log("Review fixes passed: login-form guard, crawl-safe chooser, no-click focus scan, focus-indicator diff, stale-marker safety, stable fingerprints and animation-tolerant readiness.");
} finally {
  await browser.close();
}
