import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createBrowserSession } from "../src/browser/session.js";
import { navigateAndWait, waitForPageReady } from "../src/browser/readiness.js";
import { resolveBlockingObstruction } from "../src/browser/blockers.js";
import { clickSafeAction, inventorySafeActions, restoreActionPath } from "../src/scanner/actions.js";
import { getConfig } from "../src/config.js";
import { establishPageKeyboardFocus } from "../src/assistive-technology/nvda.js";

const pages = {
  "/": `<title>Home</title><main><h1>Home</h1><p>Session lifecycle fixture home page.</p>
    <a id="blank" href="/tab" target="_blank">Open the report in a new tab</a>
    <button id="open" type="button" onclick="window.open('/win')">Open the help window</button>
    <button id="arm" type="button" onclick="window.addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = ''; })">Start editing</button></main>`,
  "/tab": "<title>Tab</title><main><h1>Report</h1><p>Opened in a new tab by a target=_blank link.</p></main>",
  "/win": "<title>Window</title><main><h1>Help</h1><p>Opened in a new window by window.open.</p></main>",
  // A full-screen loader that never finishes: readiness can only end by timeout or close.
  "/loading": '<title>Loading</title><div aria-busy="true" class="loading" style="position:fixed;inset:0">Loading</div>'
};

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="en"><body>${pages[new URL(request.url, "http://fixture").pathname] || pages["/"]}</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function openSession(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-lifecycle-"));
  const config = {
    ...getConfig({ login: false, headless: true, browserChannel: "bundled", targetUrl: baseUrl }),
    authStatePath: path.join(directory, "auth_state.json"),
    legacyAuthStatePath: null
  };
  const events = [];
  const session = await createBrowserSession(config, (event) => events.push(event));
  t.after(async () => {
    await session.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { session, events, stops: () => events.filter((event) => event.type === "browser-closed").length };
}

// Tab classification settles a microtask after the context 'page' event.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const closedWithin = (page, ms) => page.isClosed() ? Promise.resolve(true)
  : Promise.race([new Promise((resolve) => page.once("close", () => resolve(true))), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

test("NVDA focus anchor remains inside the visible native dialog", async (t) => {
  const { session } = await openSession(t);
  await session.page.setContent('<html><body><h1>Home</h1><dialog id="details"><h2>Details</h2><p>Read this dialog.</p><button>Close</button></dialog></body></html>');
  await session.page.evaluate(() => document.getElementById("details").showModal());
  assert.equal(await establishPageKeyboardFocus(session.page), true);
  const geometry = await session.page.evaluate(() => {
    const anchor = document.getElementById("rambo-nvda-focus-anchor");
    const dialog = document.getElementById("details");
    const a = anchor.getBoundingClientRect(), d = dialog.getBoundingClientRect();
    return { inside: a.x >= d.x && a.y >= d.y && a.right <= d.right && a.bottom <= d.bottom,
      dialogOpen: dialog.open, focused: document.activeElement === anchor };
  });
  assert.deepEqual(geometry, { inside: true, dialogOpen: true, focused: true });
});

test("session.close() is teardown, not the user closing the test browser", async (t) => {
  const { session, events, stops } = await openSession(t);
  await session.page.goto(`${baseUrl}/`);
  let notified = 0;
  session.onStopped(() => { notified += 1; });
  await session.close();
  await session.close();
  assert.equal(session.signal.aborted, false);
  assert.equal(session.isStopped(), false);
  assert.equal(session.stopReason, null);
  assert.doesNotThrow(() => session.throwIfStopped());
  assert.equal(stops(), 0);
  assert.equal(notified, 0);
  assert.equal(session.page.isClosed(), true);
  assert.equal(events.some((event) => event.type === "user-tab" || event.type === "popup"), false);
});

test("closing the home tab aborts the signal with TEST_BROWSER_CLOSED and reports it once", async (t) => {
  const { session, stops } = await openSession(t);
  await session.page.goto(`${baseUrl}/`);
  const heard = [];
  const unsubscribed = [];
  session.onStopped((reason) => heard.push(reason));
  const unsubscribe = session.onStopped((reason) => unsubscribed.push(reason));
  unsubscribe();
  let aborted = 0;
  session.signal.addEventListener("abort", () => { aborted += 1; });

  await session.page.close();
  assert.equal(session.signal.aborted, true);
  assert.equal(session.signal.reason?.code, "TEST_BROWSER_CLOSED");
  assert.equal(session.isStopped(), true);
  assert.equal(session.stopReason.code, "TEST_BROWSER_CLOSED");
  assert.match(session.stopReason.message, /closed/i);
  assert.throws(() => session.throwIfStopped(), (error) => error.code === "TEST_BROWSER_CLOSED");
  assert.equal(heard.length, 1);
  assert.equal(heard[0].code, "TEST_BROWSER_CLOSED");
  assert.equal(unsubscribed.length, 0);

  // A listener added after the stop still hears about it.
  const late = await new Promise((resolve) => session.onStopped(resolve));
  assert.equal(late.code, "TEST_BROWSER_CLOSED");

  // Later triggers (context close, disconnect) never report a second time.
  await session.browser.close();
  assert.equal(aborted, 1);
  assert.equal(stops(), 1);
  await assert.rejects(session.newInternalPage(), (error) => error.code === "TEST_BROWSER_CLOSED");
});

test("site-opened tabs are pending, user tabs are left alone, and closing either never stops the scan", async (t) => {
  const { session, events } = await openSession(t);
  await session.page.goto(`${baseUrl}/`);

  const [blankTab] = await Promise.all([session.page.waitForEvent("popup"), session.page.click("#blank")]);
  const [windowTab] = await Promise.all([session.page.waitForEvent("popup"), session.page.click("#open")]);
  const userTab = await session.context.newPage();
  await settle();

  assert.deepEqual(new Set(session.pendingTabs()), new Set([blankTab, windowTab]));
  assert.equal(session.pendingTabs().includes(session.page), false);
  assert.deepEqual(session.userTabs(), [userTab]);
  assert.equal(session.popupPages.has(userTab), false);
  assert.equal(session.popupPages.has(blankTab) && session.popupPages.has(windowTab), true);
  const popupEvents = events.filter((event) => event.type === "popup").map((event) => new URL(event.url).pathname);
  assert.deepEqual(popupEvents.sort(), ["/tab", "/win"]);
  assert.equal(events.filter((event) => event.type === "user-tab").length, 1);

  session.markTabHandled(blankTab);
  assert.deepEqual(session.pendingTabs(), [windowTab]);

  await blankTab.close();
  await windowTab.close();
  await userTab.close();
  assert.equal(session.popupPages.size, 0);
  assert.deepEqual(session.pendingTabs(), []);
  assert.deepEqual(session.userTabs(), []);
  assert.equal(session.signal.aborted, false);
  assert.equal(session.isStopped(), false);
});

test("internal tabs are not popups; the agent closing one is quiet but the user closing one stops the scan", async (t) => {
  const { session, events, stops } = await openSession(t);
  await session.page.goto(`${baseUrl}/`);

  const first = await session.newInternalPage();
  await settle();
  assert.equal(session.pendingTabs().includes(first), false);
  assert.equal(session.userTabs().includes(first), false);
  assert.equal(session.popupPages.has(first), false);
  assert.equal(events.some((event) => event.type === "popup" || event.type === "user-tab"), false);
  await first.close();
  assert.equal(session.isStopped(), false);

  // Closing the target outside Playwright's page.close() is what the user's
  // tab close looks like to the session.
  const second = await session.newInternalPage();
  const { targetInfo } = await (await session.context.newCDPSession(second)).send("Target.getTargetInfo");
  const browserCdp = await session.browser.newBrowserCDPSession();
  await browserCdp.send("Target.closeTarget", { targetId: targetInfo.targetId });
  assert.equal(await closedWithin(second, 5_000), true);
  assert.equal(session.signal.aborted, true);
  assert.equal(session.stopReason.code, "TEST_BROWSER_CLOSED");
  assert.equal(stops(), 1);
  assert.equal(session.page.isClosed(), false);
});

test("closing the browser directly aborts the signal", async (t) => {
  const { session, stops } = await openSession(t);
  await session.page.goto(`${baseUrl}/`);
  await session.browser.close();
  assert.equal(session.signal.aborted, true);
  assert.equal(session.signal.reason?.code, "TEST_BROWSER_CLOSED");
  assert.equal(stops(), 1);
});

test("a beforeunload handler armed after a click cannot keep the test tab open", async (t) => {
  const { session, events } = await openSession(t);
  await session.page.goto(`${baseUrl}/`);
  await session.page.click("#arm");
  await session.page.close({ runBeforeUnload: true });
  assert.equal(await closedWithin(session.page, 5_000), true);
  assert.equal(events.some((event) => event.type === "dialog" && /beforeunload/.test(event.message)), true);
  assert.equal(session.isStopped(), true);
});

test("readiness, navigation and replay give up as soon as a real tab closes", async (t) => {
  const { session } = await openSession(t);
  const tab = await session.context.newPage();
  await tab.goto(`${baseUrl}/loading`);
  const started = Date.now();
  setTimeout(() => { tab.close().catch(() => {}); }, 300);
  assert.equal(await waitForPageReady(tab, { timeout: 30_000, shellWaitMs: 30_000 }), false);
  assert.ok(Date.now() - started < 3_000, `waitForPageReady took ${Date.now() - started} ms`);

  const navigated = Date.now();
  await assert.rejects(navigateAndWait(tab, `${baseUrl}/`, { timeout: 60_000 }), (error) => error.code === "PAGE_CLOSED");
  assert.equal(await restoreActionPath(tab, `${baseUrl}/`, [{ signature: "missing" }]), false);
  assert.deepEqual(await clickSafeAction(tab, { signature: "missing" }), { clicked: false, reason: "page-closed" });
  assert.equal((await resolveBlockingObstruction(tab)).detected, false);
  assert.ok(Date.now() - navigated < 1_000, `closed-tab helpers took ${Date.now() - navigated} ms`);
  assert.equal(session.isStopped(), false);
});

// Mirrors Playwright on a closed page: every call rejects at once and url()
// keeps returning the last URL.
function closedPage() {
  const closed = async () => { throw new Error("Target page, context or browser has been closed"); };
  return {
    isClosed: () => true,
    url: () => "https://fixture.example/dashboard",
    goto: closed, goBack: closed, evaluate: closed, waitForLoadState: closed, waitForTimeout: closed,
    frames: () => [], mainFrame: () => null, on() {}, off() {},
    keyboard: { press: closed }
  };
}

async function timed(operation) {
  const started = Date.now();
  const value = await operation();
  return { value, elapsed: Date.now() - started };
}

test("waitForPageReady returns false at once on a closed page", async () => {
  const { value, elapsed } = await timed(() => waitForPageReady(closedPage(), { timeout: 60_000, shellWaitMs: 60_000 }));
  assert.equal(value, false);
  assert.ok(elapsed < 200, `took ${elapsed} ms`);
});

test("navigateAndWait rejects with PAGE_CLOSED at once on a closed page", async () => {
  const started = Date.now();
  await assert.rejects(navigateAndWait(closedPage(), "https://fixture.example/dashboard", { timeout: 60_000 }), (error) => error.code === "PAGE_CLOSED");
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
});

test("restoreActionPath, clickSafeAction, inventory and blocker recovery fail fast on a closed page", async () => {
  const restore = await timed(() => restoreActionPath(closedPage(), "https://fixture.example/dashboard", [{ signature: "a" }], { expectedRootFingerprint: "abc" }));
  assert.equal(restore.value, false);
  assert.ok(restore.elapsed < 200, `restoreActionPath took ${restore.elapsed} ms`);

  const click = await timed(() => clickSafeAction(closedPage(), { key: "k", signature: "a", frameIndex: 0, frameUrl: "https://fixture.example/dashboard" }));
  assert.deepEqual(click.value, { clicked: false, reason: "page-closed" });
  assert.ok(click.elapsed < 200, `clickSafeAction took ${click.elapsed} ms`);

  const inventory = await timed(() => inventorySafeActions(closedPage()));
  assert.deepEqual(inventory.value, []);
  assert.ok(inventory.elapsed < 200, `inventorySafeActions took ${inventory.elapsed} ms`);

  const blocker = await timed(() => resolveBlockingObstruction(closedPage()));
  assert.equal(blocker.value.detected, false);
  assert.equal(blocker.value.handled, false);
  assert.ok(blocker.elapsed < 200, `resolveBlockingObstruction took ${blocker.elapsed} ms`);
});
