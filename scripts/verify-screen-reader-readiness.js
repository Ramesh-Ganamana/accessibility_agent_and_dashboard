import assert from "node:assert/strict";
import { chromium } from "playwright";
import { assistiveTechnologyMetadata, captureScreenReaderSnapshot } from "../src/scanner/screen-reader.js";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.setContent(`<!doctype html><html lang="en"><head><title>Account</title></head><body>
    <header><nav aria-label="Primary"><a href="#main">Home</a></nav></header>
    <main id="main"><h1>Account settings</h1><button aria-label="Save profile"></button><button><svg aria-hidden="true"></svg></button></main>
    <div role="status" aria-live="polite">Profile loaded</div>
  </body></html>`);
  const snapshot = await captureScreenReaderSnapshot(page, page.mainFrame(), "https://example.test/account", "default");
  assert.notEqual(snapshot.status, "unavailable");
  assert.ok(snapshot.counts.exposedNodes > 0);
  assert.ok(snapshot.counts.controls >= 3);
  assert.ok(snapshot.counts.unnamedControls >= 1);
  assert.ok(snapshot.counts.headings >= 1);
  assert.ok(snapshot.counts.landmarks >= 2);
  assert.ok(snapshot.announcementPreview.some((entry) => entry.role === "button" && entry.name === "Save profile"));
  assert.ok(snapshot.warnings.some((warning) => /no accessible name/i.test(warning)));

  const metadata = assistiveTechnologyMetadata();
  assert.equal(metadata.actualScreenReaders.NVDA, "not-run");
  assert.equal(metadata.actualScreenReaders.JAWS, "not-run");
  assert.equal(metadata.actualScreenReaders.VoiceOver, "not-run");
  assert.equal(metadata.actualScreenReaders.TalkBack, "not-run");
  assert.equal(metadata.claim, "readiness-only");
  assert.match(metadata.disclaimer, /not a (?:test )?run with NVDA/i);
  console.log("Chromium accessibility-tree capture and honest actual-screen-reader status passed.");
} finally {
  await browser.close();
}
