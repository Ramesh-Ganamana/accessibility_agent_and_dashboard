import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { startDashboardFixture } from "./helpers/dashboard-fixture.js";

const fixture = await startDashboardFixture();
const output = path.join(os.tmpdir(), "rambo-dashboard-preview");
await fs.mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.baseUrl, { waitUntil: "networkidle" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.ok(await page.locator("#scan-workspace").evaluate((node) => node.getBoundingClientRect().top < 150));
  assert.equal(await page.locator("#main-content > section").first().getAttribute("id"), "scan-workspace");
  assert.equal(await page.locator(".workspace-nav button").first().getAttribute("data-workspace-nav"), "scan");
  const nav = (name) => page.locator(`.workspace-nav [data-workspace-nav="${name}"]`);
  for (const tab of ["issues", "crawl", "assistive", "vpat", "remediation", "overview"]) {
    await nav(tab).click();
    assert.equal(await page.locator(`#panel-${tab}`).isVisible(), true);
    assert.equal(await nav(tab).getAttribute("aria-current"), "page");
  }
  await page.screenshot({ path: path.join(output, "desktop.png") });
  assert.equal(await page.locator("#health-ring").evaluate((node) => getComputedStyle(node).getPropertyValue("--score-color").trim()), "#946009", "the sample C grade must use the amber score ring");
  await nav("comparison").click();
  assert.ok(await page.locator("#comparison-shell").isVisible());
  assert.equal(await page.locator("#report-shell").isVisible(), false);
  await nav("scan").click();
  assert.ok(await page.locator("#target-url").evaluate((node) => document.activeElement === node));
  await page.locator("#auth-enabled").check();
  assert.ok(await page.locator("#auth-fields").isVisible());
  await page.locator("#auth-enabled").uncheck();
  await page.screenshot({ path: path.join(output, "scan.png") });
  await nav("overview").click();
  for (const dark of [false, true]) {
    if (dark) await page.locator("#theme-toggle").click();
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    console.log(JSON.stringify({ theme: dark ? "dark" : "light", violations: axe.violations.map((rule) => ({ id: rule.id, count: rule.nodes.length, nodes: rule.nodes.slice(0, 8).map((node) => ({ target: node.target, detail: node.failureSummary })) })) }));
    assert.deepEqual(axe.violations.map((rule) => rule.id), [], "the dashboard fixture must pass automated A/AA checks in each theme");
    if (dark) await page.screenshot({ path: path.join(output, "dark.png") });
  }
  await page.locator("#theme-toggle").click();
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ["overview", "issues", "assistive", "comparison", "scan"]) {
      await nav(view).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(overflow < 2, `${view} at ${width}px overflows by ${overflow}px`);
    }
    if (width === 390) {
      await nav("overview").click(); await page.screenshot({ path: path.join(output, "mobile.png") });
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Workspace navigation, separate comparison, scan/login controls, responsive layout and JS checks passed. Preview: ${output}`);
} finally { await browser?.close(); await fixture.close(); }
