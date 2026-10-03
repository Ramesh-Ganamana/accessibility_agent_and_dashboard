import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { navigateAndWait } from "../src/browser/readiness.js";

const port = 4184;
let callbackLoads = 0;
const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/race-start") {
    response.end(page("<h1>Starting redirect</h1>"));
    return;
  }
  if (request.url === "/slow-route") {
    await new Promise((resolve) => setTimeout(resolve, 700));
    response.end(page("<h1>Slow route</h1>"));
    return;
  }
  if (request.url?.startsWith("/callback")) {
    callbackLoads += 1;
    response.end(page(`<h1>Completing authentication</h1><script>setTimeout(()=>location.replace('/dashboard'),250)</script>`));
    return;
  }
  response.end(page("<h1>Authenticated dashboard</h1><button>View rewards</button>"));
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const pageInstance = await browser.newPage();
try {
  await pageInstance.goto(`http://127.0.0.1:${port}/race-start`, { waitUntil: "domcontentloaded" });
  const competingNavigation = new Promise((resolve) => setTimeout(() => {
    pageInstance.goto(`http://127.0.0.1:${port}/callback?code=one-time&state=fixture`, { waitUntil: "commit" }).catch(() => {}).finally(resolve);
  }, 100));
  await navigateAndWait(pageInstance, `http://127.0.0.1:${port}/slow-route`, { timeout: 10_000, settleMs: 200 });
  await competingNavigation;
  assert.equal(new URL(pageInstance.url()).pathname, "/dashboard");
  assert.equal(callbackLoads, 1);
  assert.match(await pageInstance.locator("body").innerText(), /Authenticated dashboard/);
  console.log("Interrupted navigation followed the one-time callback to the stable authenticated page.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

function page(body) {
  return `<!doctype html><html lang="en"><head><title>Navigation race fixture</title></head><body><main>${body}</main></body></html>`;
}
