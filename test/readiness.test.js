import test from "node:test";
import assert from "node:assert/strict";
import { navigateAndWait, waitForPageReady } from "../src/browser/readiness.js";

test("browser connection-error documents never become successful application scans", async () => {
  const failure = new Error("net::ERR_CONNECTION_REFUSED");
  const page = {
    goto: async () => { throw failure; }, url: () => "chrome-error://chromewebdata/",
    waitForLoadState: async () => {},
    evaluate: async () => ({ ready: true, busy: false })
  };
  await assert.rejects(navigateAndWait(page, "https://fixture.example/"), failure);
});

test("a tab closed after navigation commits is reported as closed within milliseconds, not as an unrendered page", async () => {
  let closed = false;
  const gone = async () => { throw new Error("Target page, context or browser has been closed"); };
  const page = {
    isClosed: () => closed,
    goto: async () => { closed = true; return null; }, url: () => "https://fixture.example/dashboard",
    waitForLoadState: gone, evaluate: gone, waitForTimeout: gone
  };
  const started = Date.now();
  await assert.rejects(navigateAndWait(page, "https://fixture.example/dashboard", { timeout: 60_000 }), (error) => error.code === "PAGE_CLOSED" && !/meaningful page content/.test(error.message));
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
  assert.equal(await waitForPageReady(page, { timeout: 60_000 }), false);
});
