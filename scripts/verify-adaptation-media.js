import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { scanVisualAdaptation } from "../src/scanner/adaptation.js";
import { scanMedia } from "../src/scanner/media.js";
import { createEvidenceRegistry } from "../src/scanner/evidence.js";

// Local synthetic pages only: zoom, reflow, text spacing and media checks.
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "adaptation-media-"));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let index = 0;
  const adapt = async (html, canResize = true) => {
    await page.setContent(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">${html}</body></html>`);
    const result = await scanVisualAdaptation(page, "https://fixture.test/", { canResize, outputDir, evidenceRegistry: createEvidenceRegistry(), nextEvidenceIndex: () => ++index });
    return { rules: result.findings.map((finding) => finding.ruleId), result };
  };

  const clean = await adapt("<main style='padding:16px'><h1>Responsive page</h1><p>This paragraph wraps naturally at any width without clipping.</p></main>");
  assert.deepEqual(clean.rules, [], "a responsive page has no adaptation findings");
  assert.deepEqual(page.viewportSize(), { width: 1280, height: 800 }, "the viewport is restored after the checks");

  const wide = await adapt("<main><div style='width:900px'><p>This fixed-width column forces the page to scroll sideways on a small screen.</p></div></main>");
  assert.ok(wide.rules.includes("reflow-horizontal-scroll"), `a fixed 900 px column fails reflow (${wide.rules.join(", ")})`);
  const reflow = wide.result.findings.find((finding) => finding.ruleId === "reflow-horizontal-scroll");
  assert.ok(reflow.evidence && reflow.evidenceKind === "condition", "the reflow finding carries a screenshot taken at 320 px");

  const zoom = await adapt("<main><div style='width:30vw;white-space:nowrap;overflow:hidden'>Account balance summary for the selected portfolio</div></main>");
  assert.ok(zoom.rules.some((rule) => rule === "zoom-text-clipped" || rule === "reflow-text-clipped"), `text clipped at smaller widths is reported (${zoom.rules.join(", ")})`);

  const spacing = await adapt("<main><p style='height:38px;overflow:hidden;width:320px;line-height:1.1;font-size:16px;margin:0'>Two lines of important instructions that fit exactly at the default line height.</p></main>");
  assert.ok(spacing.rules.includes("text-spacing-clipped"), `text clipped by WCAG text spacing is reported (${spacing.rules.join(", ")})`);
  assert.equal(await page.evaluate(() => document.querySelectorAll("[data-a11y-text-spacing]").length), 0, "the injected text-spacing style is removed");

  const shared = await adapt("<main><div style='width:900px'><p>Wide content</p></div></main>", false);
  assert.ok(shared.result.skipped.length && !shared.rules.includes("reflow-horizontal-scroll"), "a shared NVDA window is not resized; the skip is reported");

  await page.setContent(`<!doctype html><html lang="en"><body><main>
    <video id="promo" src="data:video/mp4;base64," autoplay muted loop style="width:320px;height:180px"></video>
    <video id="captioned" controls style="width:320px;height:180px"><track kind="captions" src="data:text/vtt,WEBVTT" srclang="en"><track kind="descriptions" src="data:text/vtt,WEBVTT"></video>
    <audio id="jingle" src="data:audio/mpeg;base64," autoplay></audio>
    <iframe src="https://www.youtube.com/embed/abc123" style="width:320px;height:180px"></iframe>
    <marquee>Breaking market update</marquee>
  </main></body></html>`);
  const media = await scanMedia(page, "https://fixture.test/");
  const byTarget = (target) => media.filter((finding) => finding.target[0].includes(target)).map((finding) => finding.ruleId);
  assert.ok(byTarget("promo").includes("media-captions") && byTarget("promo").includes("media-pause-control"), `an autoplaying uncaptioned video is reported (${byTarget("promo").join(", ")})`);
  assert.deepEqual(byTarget("captioned"), [], "a captioned, described video with controls is not reported");
  assert.ok(byTarget("jingle").includes("media-autoplay-audio"), "autoplaying audio is reported");
  assert.ok(media.some((finding) => finding.ruleId === "media-embedded-player") && media.some((finding) => finding.ruleId === "media-embedded-player-title"), "an untitled embedded YouTube player is reported");
  assert.ok(media.some((finding) => finding.ruleId === "media-moving-content"), "a marquee without a pause control is reported");

  console.log("Adaptation and media checks passed: reflow, zoom, text spacing, viewport restore, NVDA-safe skip, captions, autoplay, embedded players and moving content.");
} finally {
  await browser.close();
  await fs.rm(outputDir, { recursive: true, force: true });
}
