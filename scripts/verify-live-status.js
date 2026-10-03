import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  let statusReads = 0;
  await page.route("**/api/scans", async (route) => {
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "job-ui-status", status: "queued", progress: 0, events: [] }) });
  });
  await page.route("**/api/jobs/job-ui-status", async (route) => {
    statusReads += 1;
    const common = { id: "job-ui-status", startedAt: new Date(Date.now() - 4_000).toISOString(), currentUrl: "https://application.test/login", warningCount: 0 };
    const job = statusReads === 1
      ? { ...common, status: "running", phase: "Authentication", progress: 23, error: null, events: [{ at: new Date().toISOString(), type: "session", message: "Submitting the password and waiting for the application callback." }] }
      : { ...common, status: "failed", phase: "Failed", progress: 23, error: "The authentication callback did not finish.", events: [{ at: new Date().toISOString(), type: "failed", message: "The authentication callback did not finish." }] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job) });
  });

  await page.goto("http://127.0.0.1:4173", { waitUntil: "networkidle" });
  await page.locator("#target-url").fill("https://application.test/");
  await page.locator('#scan-form button[type="submit"]').click();

  await page.locator("#job-progress.running, #job-progress.waiting").waitFor();
  assert.equal(await page.locator("#job-percent").textContent(), "23%");
  assert.match(await page.locator("#job-message").textContent(), /Submitting the password/);

  await page.locator("#job-progress.failed").waitFor({ timeout: 5_000 });
  assert.equal(await page.locator("#job-progress").getAttribute("role"), "alert");
  assert.match(await page.locator("#job-message").textContent(), /did not finish/);
  assert.match(await page.locator("#job-detail").textContent(), /press Start scan to retry/);
  console.log("Live running and immediate failure status UI passed.");
} finally {
  await browser.close();
}
