import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { getConfig } from "../src/config.js";
import { createBrowserSession } from "../src/browser/session.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";
import { scanRequestError } from "../src/scan-request.js";
import { buildAndroidReport, writeAndroidReport } from "../src/mobile/android-report.js";
import { app } from "../src/server.js";
const FIXTURE = await fs.readFile(new URL("../test/fixtures/android-screen.xml", import.meta.url), "utf8");

// Mobile web emulation and native Android reports, all local.
const site = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Mobile fixture</title>
    <style>nav a{display:inline-block;padding:2px;font-size:12px} @media (max-width:600px){.wide{display:none}}</style></head>
    <body><main><h1>Accounts</h1><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav><p class="wide">Desktop only</p></main></body></html>`);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${site.address().port}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-"));
const reportsDir = getConfig().reportsDir;
const androidId = `android-fixture-${Date.now().toString(36)}`;
let browser;
let server;
try {
  const config = getConfig({ targetUrl: origin, login: false, headless: true, browserChannel: "bundled", aiEnabled: false, device: "mobile" });
  config.authStatePath = path.join(root, "auth.json");
  config.legacyAuthStatePath = null;
  const session = await createBrowserSession(config);
  try {
    await session.page.goto(origin);
    assert.deepEqual(session.page.viewportSize(), { width: 412, height: 839 }, "the Pixel 7 viewport is emulated");
    const traits = await session.page.evaluate(() => ({ coarse: matchMedia("(pointer: coarse)").matches, touch: navigator.maxTouchPoints > 0, mobileUa: /Mobile/.test(navigator.userAgent), hidden: getComputedStyle(document.querySelector(".wide")).display }));
    assert.deepEqual(traits, { coarse: true, touch: true, mobileUa: true, hidden: "none" }, "touch, coarse pointer, mobile user agent and media queries apply");
  } finally {
    await session.browser.close();
  }
  const nvdaConfig = getConfig({ targetUrl: origin, device: "mobile", nvda: { requested: true } });
  assert.equal(nvdaConfig.device, "mobile");
  assert.equal(scanRequestError({ targetUrl: origin, device: "tablet" }), "Choose a desktop or mobile viewport.");
  assert.match(scanRequestError({ targetUrl: origin, device: "mobile", screenReaders: { nvda: true } }), /desktop browser window/);
  assert.equal(scanRequestError({ targetUrl: origin, device: "mobile" }), null);

  const scanConfig = getConfig({ targetUrl: origin, login: false, headless: true, browserChannel: "bundled", aiEnabled: false, device: "mobile", maxPages: 1, maxDepth: 0 });
  scanConfig.reportsDir = path.join(root, "reports");
  scanConfig.authStatePath = path.join(root, "auth.json");
  scanConfig.legacyAuthStatePath = null;
  const report = await runAccessibilityScan(scanConfig, () => {});
  assert.equal(report.configuration.device, "mobile (Pixel 7 emulation)");
  assert.ok(report.issues.some((issue) => issue.ruleId === "target-size"), `tiny tap targets are found in the mobile layout (${report.issues.map((issue) => issue.ruleId).join(", ")})`);

  const screens = [{ name: "Login", xml: FIXTURE, screenshot: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), density: 2.625, activity: "com.example.bank/.LoginActivity", packageName: "com.example.bank" }];
  await writeAndroidReport(buildAndroidReport({ id: androidId, screens, device: { serial: "emulator-5554", model: "Pixel 9" } }), screens, reportsDir);
  server = await new Promise((resolve, reject) => { const result = app.listen(0, "127.0.0.1", () => resolve(result)); result.once("error", reject); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#report-current").selectOption(androidId);
  await page.waitForFunction(() => document.querySelector("#report-domain")?.textContent === "com.example.bank");
  await page.locator("#tab-issues").click();
  await page.waitForFunction(() => /android-control-no-name|Interactive elements need an accessible name/.test(document.body.innerText));
  await page.locator("#tab-vpat").click();
  assert.deepEqual(errors, []);
  console.log("Mobile passed: Pixel 7 emulation (viewport, touch, user agent), NVDA/mobile guard, mobile scan with target-size, and an Android report in the dashboard.");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => site.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(path.join(reportsDir, androidId), { recursive: true, force: true });
}
