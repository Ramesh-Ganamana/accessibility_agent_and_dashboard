import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { installActionExclusions, prepareActionExclusions, guardedClick, extendActionExclusionScope, assertKeyAllowed, isActionExcluded } from "../src/browser/action-exclusions.js";
import { inventorySafeActions, clickSafeAction, restoreActionPath } from "../src/scanner/actions.js";
import { discoverNavigationActions } from "../src/scanner/discovery.js";
import { attemptAiGroundedAction, buildNumberedDomMap, removeGroundingOverlays } from "../src/scanner/ai-grounding.js";
import { resolveBlockingObstruction } from "../src/browser/blockers.js";
import { ensureAuthenticated } from "../src/browser/session.js";
import { findLoginControlWithAI } from "../src/browser/ai-login.js";
import { getConfig } from "../src/config.js";

const markup = `<!doctype html><html lang=en><head><title>Exclusion fixture</title></head><body>
<script>window.activated=[];function hit(id){activated.push(id)}</script>
<button id=first onclick="hit(this.id)">First action</button>
<button id=second aria-label="Second action" onclick="hit(this.id)"><span id=second-child>Icon</span></button>
<a id=image-link href=/provider onclick="event.preventDefault();hit(this.id)"><img alt="Kaiser Permanente" src="/brand.svg" width=80 height=40></a>
<button id=aria aria-labelledby=aria-name onclick="hit(this.id)"><span>Logo</span></button><span id=aria-name>Referenced action</span>
<a id=url-link href=/blocked-route onclick="event.preventDefault();hit(this.id)">Different name</a>
<button id=title title="Special title" onclick="hit(this.id)">Visible caption</button>
<button id=safe onclick="hit(this.id)">View details</button>
<button id=similar onclick="hit(this.id)">First action details</button>
<button id=late onclick="hit(this.id)">Open information</button>
<button id=by-id onclick="hit(this.id)">Alpha</button>
<button id=by-data data-test=remove-item onclick="hit(this.id)">Beta</button>
<button id=by-class class="btn danger-zone" onclick="hit(this.id)">Gamma</button>
<a id=by-phrase href=/partners onclick="event.preventDefault();hit(this.id)">Visit Acme Partners today</a>
<button id=by-selector class="cta primary" onclick="hit(this.id)">Delta</button>
<button id=payroll onclick="hit(this.id)">Payroll summary</button>
<div id=shadow></div><script>shadow.attachShadow({mode:'open'}).innerHTML='<a id=shadow-link href=/shadow-route onclick="event.preventDefault()"><img alt="Shadow provider" src=/brand.svg width=80 height=40></a>'</script>
</body></html>`;
// Controls whose accessible name differs from their raw text, components,
// clickable cards and containers that must not cause false blocks.
const namesMarkup = `<!doctype html><html lang=en><head><title>Name fixture</title>
<style>.gen::before{content:"Refresh data"} .block{display:block} .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style></head><body>
<script>window.activated=[];function hit(id){activated.push(id)}</script>
<button id=icon onclick="hit(this.id)"><span aria-hidden="true">expand_more</span>View insurance cards</button>
<a id=block href=/kp onclick="event.preventDefault();hit(this.id)"><span class=block>Kaiser</span><span class=block>Permanente</span></a>
<button id=br onclick="hit(this.id)">Open<br>statements</button>
<button id=badge onclick="hit(this.id)">View claims<span hidden>beta</span></button>
<a id=alttext href=/branches onclick="event.preventDefault();hit(this.id)"><img alt="Branch" src="/brand.svg" width=20 height=20> locator</a>
<button id=gen class=gen onclick="hit(this.id)"></button>
<button id=srtext onclick="hit(this.id)">&#9881;<span class=sr>Open settings</span></button>
<a id=svglink href=/settings onclick="event.preventDefault();hit(this.id)" style="display:inline-block;padding:24px"><svg role=img aria-label="Account settings" width=20 height=20><circle cx=10 cy=10 r=9 /></svg></a>
<div id=card style="cursor:pointer;display:inline-block;padding:8px"><h3>Team page</h3><span id=card-sub>Opens the staff directory</span></div>
<div id=other-card style="cursor:pointer;display:inline-block;padding:8px"><h3>Holiday calendar</h3><span id=other-sub>See upcoming dates</span></div>
<ds-link id=dslink href=/benefits>Benefits portal</ds-link>
<vault-button id=vault></vault-button>
<main tabindex=-1 aria-labelledby=page-title><h1 id=page-title>Statements</h1><button id=details onclick="hit(this.id)">View details</button></main>
<div tabindex=0 id=row><a id=promo href=/promo onclick="event.preventDefault();hit(this.id)"><img alt="Promo banner" src=/brand.svg width=20 height=20></a> <button id=view-plans onclick="hit(this.id)">View plans</button></div>
<button id=hero class="btn home-hero" onclick="hit(this.id)">Show offers</button>
<a id=news href=/home/news onclick="event.preventDefault();hit(this.id)">Latest news</a>
<button id=open-notice onclick="document.getElementById('notice').showModal()">Open notice</button>
<dialog id=notice><p>Important notice</p><button id=notice-close onclick="this.closest('dialog').close()">Close</button></dialog>
<script>
customElements.define("ds-link", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<a part=link><slot></slot></a>'; }
  connectedCallback() { const a = this.shadowRoot.querySelector("a"); a.href = this.getAttribute("href"); a.addEventListener("click", (event) => { event.preventDefault(); hit("dslink"); }); } });
customElements.define("vault-button", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "<span>Open vault</span>"; this.setAttribute("role", "button"); this.tabIndex = 0; this.addEventListener("click", () => hit("vault")); } });
document.getElementById("card").addEventListener("click", () => hit("card"));
document.getElementById("other-card").addEventListener("click", () => hit("other-card"));
document.getElementById("notice").addEventListener("cancel", () => fetch("/hit/escape"));
</script></body></html>`;
const nameEntries = ["View insurance cards", "Kaiser Permanente", "Open statements", "View claims", "Branch locator", "Refresh data", "Open settings", "Account settings", "Team page",
  "Benefits portal", "Open vault", "Statements", "Promo banner", "Home", "Close"];
const serverHits = [];
const server = http.createServer((request, response) => {
  if (request.url.startsWith("/blocked-route")) serverHits.push(request.url);
  if (request.url.startsWith("/hit/")) { serverHits.push(request.url); response.writeHead(204); response.end(); return; }
  if (request.url === "/names") { response.writeHead(200, { "Content-Type": "text/html" }); response.end(namesMarkup); return; }
  if (request.url === "/login-entry") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<!doctype html><html lang=en><title>Welcome</title><body><h1>Welcome</h1><button type=button id=member>Kaiser member portal</button><button type=button id=staff>Staff portal</button></body></html>');
    return;
  }
  if (request.url === "/login") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<!doctype html><html lang=en><title>Login fixture</title><body><h1>Login</h1><label>Email<input type=email id=email></label><label>Password<input type=password id=password></label><button type=button id=submit onclick="document.body.dataset.submitted=1">Sign in</button></body></html>');
    return;
  }
  if (request.url === "/brand.svg") { response.writeHead(200, { "Content-Type": "image/svg+xml" }); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="blue"/></svg>'); return; }
  response.writeHead(200, { "Content-Type": "text/html" }); response.end(markup);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const targetUrl = `http://127.0.0.1:${server.address().port}`;
const labels = [" FIRST   action ", "Second action", "Kaiser Permanente", "Referenced action", "/blocked-route", "Special title", "Shadow provider", "Close", "Sign in",
  "#by-id", "data-test=remove-item", "danger-zone", "Acme Partners", "button.cta.primary", "Pay"];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await installActionExclusions(context, { targetUrl, excludeActionLabels: labels });
  const page = await context.newPage();
  await page.goto(targetUrl);
  const actions = await inventorySafeActions(page);
  // Text entries match whole words inside a label ("First action" blocks
  // "First action details") but never part of a word ("Pay" leaves "Payroll").
  assert.deepEqual(actions.map((action) => action.label).sort(), ["Open information", "Payroll summary", "View details"].sort());
  assert.equal((await discoverNavigationActions(page, targetUrl)).length, 0, "excluded image/URL/shadow links cannot enter the crawl queue");
  for (const id of ["first", "second", "second-child", "image-link", "aria", "url-link", "title", "similar", "by-id", "by-data", "by-class", "by-phrase", "by-selector"]) {
    await assert.rejects(guardedClick(page.locator(`#${id}`)), { code: "USER_EXCLUDED_ACTION" });
    // Even a helper missing its own check must not activate the excluded target.
    await page.locator(`#${id}`).click();
  }
  await page.locator("#first").focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => activated), []);
  const safe = actions.find((action) => action.label === "View details");
  assert.equal((await clickSafeAction(page, safe)).clicked, true);
  assert.deepEqual(await page.evaluate(() => activated), ["safe"]);

  await page.evaluate(() => {
    const race = document.createElement("button");
    race.id = "race"; race.textContent = "Open race fixture";
    race.onpointerover = () => race.title = "Special title";
    race.onclick = () => activated.push("race");
    document.body.append(race);
  });
  await assert.rejects(guardedClick(page.locator("#race")), { code: "USER_EXCLUDED_ACTION" });
  assert.deepEqual(await page.evaluate(() => activated), ["safe"], "last-moment pointer label changes must not activate the action");

  const late = actions.find((action) => action.label === "Open information");
  await page.locator("#late").evaluate((element) => element.setAttribute("title", "Special title"));
  assert.equal((await clickSafeAction(page, late)).clicked, false, "late alias changes must be checked again");

  let inspected = false;
  await attemptAiGroundedAction(page, { config: { excludeActionLabels: labels, excludeActionOrigin: targetUrl }, chooseNumber: async ({ allowed }) => {
    inspected = true;
    for (const forbidden of ["Kaiser Permanente", "First action", "First action details", "Second action", "Special title", "Referenced action", "Different name", "Shadow provider", "Icon", "Alpha", "Beta", "Gamma", "Visit Acme Partners today", "Delta"])
      assert.ok(!allowed.some((entry) => entry.label === forbidden), `AI must not receive ${forbidden} as allowed`);
    // Change the selected element after inventory to exercise final click guard.
    const selected = allowed.find((entry) => entry.label === "View details");
    assert.ok(selected);
    await page.locator("#safe").evaluate((element) => element.setAttribute("title", "Special title"));
    return { action: "click", number: selected.number, confidence: 1 };
  } });
  assert.ok(inspected);
  assert.deepEqual(await page.evaluate(() => activated), ["safe"]);
  await guardedClick(page.locator("#payroll"));
  assert.deepEqual(await page.evaluate(() => activated), ["safe", "payroll"], "a whole-word entry must not block a control that only contains it inside a word");

  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.innerHTML = '<h2>Optional panel</h2><button type=button onclick="this.closest(\'dialog\').close()">Close</button>';
    document.body.append(dialog); dialog.showModal();
  });
  const blocker = await resolveBlockingObstruction(page);
  assert.equal(blocker.reason, "user_excluded_action");
  assert.equal(await page.locator("dialog").evaluate((element) => element.open), true, "Escape must not bypass an excluded close control");

  const another = await context.newPage();
  const loginConfig = getConfig({ targetUrl, excludeActionLabels: labels, login: {
    url: `${targetUrl}/login`, username: "fixture@example.test", password: "fixture-only", persist: false,
    emailSelector: "#email", passwordSelector: "#password", submitSelector: "#submit"
  } });
  await assert.rejects(ensureAuthenticated({ page: another, loadedStorage: false }, loginConfig), { code: "USER_EXCLUDED_ACTION" });
  assert.equal(await another.locator("body").getAttribute("data-submitted"), null, "login must not bypass an excluded sign-in action");
  await another.goto(targetUrl);
  await assert.rejects(guardedClick(another.locator("#first")), { code: "USER_EXCLUDED_ACTION" });
  // Image source URL is accepted independently of the link's name/destination.
  await prepareActionExclusions(another, { excludeLabels: [`${targetUrl}/brand.svg`] });
  await assert.rejects(guardedClick(another.locator("#image-link")), { code: "USER_EXCLUDED_ACTION" });
  await another.goto(targetUrl.replace("127.0.0.1", "localhost"));
  await guardedClick(another.locator("#first"));
  assert.deepEqual(await another.evaluate(() => activated), ["first"], "application rules must not leak to a different origin");
  // A script navigation to a listed address (with a trailing slash and
  // fragment) is refused before the request is sent.
  await another.goto(targetUrl);
  await another.evaluate(() => { location.href = "/blocked-route/#top"; }).catch(() => {});
  await another.waitForTimeout(500);
  assert.deepEqual(serverHits.filter((hit) => hit.startsWith("/blocked-route")), [], "a listed page address is never requested");
  assert.equal(new URL(another.url()).pathname, "/");
  await another.goto(targetUrl.replace("127.0.0.1", "localhost"));
  // A start address that lands on another host the scan then uses: the list is
  // extended there and stays for new documents.
  await extendActionExclusionScope(context, targetUrl.replace("127.0.0.1", "localhost"));
  await assert.rejects(guardedClick(another.locator("#second")), { code: "USER_EXCLUDED_ACTION" });
  await another.reload();
  await assert.rejects(guardedClick(another.locator("#first")), { code: "USER_EXCLUDED_ACTION" });
  await another.locator("#first").click();
  assert.deepEqual(await another.evaluate(() => activated), [], "an extended scope also covers fresh documents");

  // www/https variants of the configured origin belong to the same application.
  const variantContext = await browser.newContext();
  const localOrigin = targetUrl.replace("127.0.0.1", "localhost");
  await installActionExclusions(variantContext, { targetUrl: localOrigin, excludeActionLabels: labels });
  const variant = await variantContext.newPage();
  await variant.goto(localOrigin.replace("localhost", "www.localhost"));
  assert.equal(await isActionExcluded(variant.locator("#first")), true, "a www redirect of the start address keeps the list");
  await variant.locator("#first").click();
  await variant.locator("#safe").click();
  assert.deepEqual(await variant.evaluate(() => activated), ["safe"]);
  // Blocker recovery on a fresh www document that no helper has primed yet
  // must not use a listed dismiss control.
  await variant.reload();
  await variant.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.innerHTML = '<h2>Optional panel</h2><button type=button onclick="hit(\'variant-close\');this.closest(\'dialog\').close()">Close</button>';
    document.body.append(dialog); dialog.showModal();
  });
  assert.equal((await resolveBlockingObstruction(variant)).reason, "user_excluded_action");
  assert.deepEqual(await variant.evaluate(() => activated), [], "blocker recovery after a www redirect keeps a listed dismiss control unclicked");
  assert.equal(await variant.locator("dialog").evaluate((element) => element.open), true);
  await variantContext.close();

  // The AI login fallback on the www variant of the start address never offers
  // a listed control to the model, so login continues with an unlisted one.
  const modelInputs = [];
  const model = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const inventory = JSON.parse(JSON.parse(raw || "{}").input || "{}");
    modelInputs.push(inventory);
    const pick = (inventory.controls || []).find((control) => control.text === "Kaiser member portal") || (inventory.controls || []).find((control) => control.text === "Staff portal");
    const decision = { action: "click_login_entry", controlId: pick?.controlId || "", confidence: 0.97, reason: "fixture" };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "resp_fixture", object: "response", created_at: 0, status: "completed", model: "fixture",
      output: [{ type: "message", id: "msg_fixture", status: "completed", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(decision), annotations: [] }] }] }));
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${model.address().port}/v1`;
  try {
    const loginContext = await browser.newContext();
    await installActionExclusions(loginContext, { targetUrl: localOrigin, excludeActionLabels: ["Kaiser member portal"] });
    const loginPage = await loginContext.newPage();
    await loginPage.goto(`${localOrigin.replace("localhost", "www.localhost")}/login-entry`);
    const choice = await findLoginControlWithAI({ page: loginPage, expectedAction: "click_login_entry",
      config: { login: { aiEnabled: true }, openAiApiKey: "fixture-key-not-a-credential", openAiModel: "fixture" } });
    assert.equal(modelInputs.length, 1, "the login model stub was asked once");
    assert.ok(!modelInputs[0].controls.some((control) => control.text === "Kaiser member portal"), "a listed login control is never offered to the model");
    assert.equal(await choice?.locator.getAttribute("id"), "staff", "login continues with an unlisted control");
    await loginContext.close();
  } finally {
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previousBaseUrl;
    await new Promise((resolve) => model.close(resolve));
  }

  // Accessible names that differ from raw text, components, cards and containers.
  const namesContext = await browser.newContext();
  await installActionExclusions(namesContext, { targetUrl, excludeActionLabels: nameEntries });
  const names = await namesContext.newPage();
  await names.goto(`${targetUrl}/names`);
  const listedIds = ["icon", "block", "br", "badge", "alttext", "gen", "srtext", "svglink", "card", "card-sub", "dslink", "vault", "promo"];
  for (const id of listedIds) {
    await assert.rejects(guardedClick(names.locator(`#${id}`)), { code: "USER_EXCLUDED_ACTION" }, `${id} must be refused`);
    await names.locator(`#${id}`).click();
  }
  await assert.rejects(guardedClick(names.getByRole("link", { name: "Benefits portal" })), { code: "USER_EXCLUDED_ACTION" });
  await names.getByRole("link", { name: "Benefits portal" }).click();
  assert.deepEqual(await names.evaluate(() => activated), [], "listed controls whose name comes from layout, CSS, images, slots or closed shadow roots stay unclicked");
  const nameInventory = (await inventorySafeActions(names)).map((action) => action.label);
  for (const label of ["View details", "View plans", "Show offers", "Latest news", "Holiday calendar See upcoming dates"]) assert.ok(nameInventory.includes(label), `${label} stays available (${nameInventory.join(" | ")})`);
  for (const id of ["details", "view-plans", "hero", "news", "other-sub"]) await guardedClick(names.locator(`#${id}`));
  assert.deepEqual(await names.evaluate(() => activated), ["details", "view-plans", "hero", "news", "other-card"],
    "focus containers, sibling images, class tokens and URL folders do not block unlisted controls");
  let offered = [];
  await attemptAiGroundedAction(names, { config: { excludeActionLabels: nameEntries, excludeActionOrigin: targetUrl }, chooseNumber: async ({ allowed }) => {
    offered = allowed.map((entry) => entry.label);
    return { action: "none", number: 0, confidence: 0 };
  } });
  for (const label of ["View insurance cards", "Kaiser Permanente", "Open statements", "View claims", "Refresh data", "Open settings", "Open vault", "Benefits portal"]) assert.ok(!offered.includes(label), `AI must not be offered ${label}`);
  assert.ok(offered.includes("View details"));

  // Keys on a focused listed control are refused; Escape is not used to close a
  // dialog whose close control is listed.
  await names.locator("#icon").focus();
  await assert.rejects(assertKeyAllowed(names, "Enter"), { code: "USER_EXCLUDED_ACTION" });
  await names.locator("#details").focus();
  await assertKeyAllowed(names, "Enter");
  await names.locator("#open-notice").click();
  assert.equal(await restoreActionPath(names, `${targetUrl}/names`, [], { expectedRootFingerprint: "not-the-current-state" }), true);
  assert.deepEqual(serverHits.filter((hit) => hit === "/hit/escape"), [], "restore must not press Escape on a dialog with a listed close control");

  // Grounding keys from an earlier map never make a later pick ambiguous.
  await buildNumberedDomMap(names);
  await names.locator("#hero").evaluate((element) => { element.style.display = "none"; });
  await buildNumberedDomMap(names);
  const keys = await names.evaluate(() => [...document.querySelectorAll("[data-a11y-ground-key]")].map((element) => element.getAttribute("data-a11y-ground-key")));
  assert.equal(new Set(keys).size, keys.length, "grounding keys are unique after a second map");
  await removeGroundingOverlays(names);

  // document.open() erases window listeners; the guard puts them back.
  await names.evaluate(() => {
    document.open();
    document.write('<!doctype html><title>Rewritten</title><button id=rewritten onclick="window.rewrittenHits=(window.rewrittenHits||0)+1">Open extras</button>');
    document.close();
    document.getElementById("rewritten").onpointerover = (event) => { event.currentTarget.title = "Team page"; };
  });
  await assert.rejects(guardedClick(names.locator("#rewritten")), { code: "USER_EXCLUDED_ACTION" });
  assert.equal(await names.evaluate(() => window.rewrittenHits || 0), 0, "a rewritten document keeps the click guard");
  await namesContext.close();
  console.log("Multiple button/image/link exclusions, whole-word text, id/class/data attributes, attribute=value, CSS selectors, aliases, URLs, shadow controls, child hits, native activation, AI recheck, dialog/login click guard, origin scope and new-page policy passed.");
  console.log("Accessible-name variants, slotted and closed-shadow components, clickable cards, focus containers, www/extended scope, AI login inventory, key and Escape guards, grounding keys and document.open() passed.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
