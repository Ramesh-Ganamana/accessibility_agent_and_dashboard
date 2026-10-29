import { spawnSync } from "node:child_process";

// Local browser fixtures that need no real NVDA, paid AI calls or external sites.
// Excluded on purpose: verify-ai-auth-flow (live AI), verify-nvda-live-browser and
// verify-nvda-browser-filter (they drive the real desktop reader).
const fixtures = [
  "action-exclusions", "action-exclusions-crawl", "action-login-gate", "adaptation-media", "ai-grounding", "ai-grounding-crawl", "audit-workflow", "auth-flow",
  "automatic-auth-flow", "blocker-recovery", "compliance", "crawl-actions", "crawl-limits", "dashboard-refresh", "dashboard-score",
  "documents", "financial-workflow", "interaction-crawl", "journeys", "keyboard-checks", "live-nvda-crawl",
  "live-status", "mobile", "nvda-after-crawl", "navigation-race", "needs-review-evidence", "nvda-state-replay", "post-login-setup",
  "protected-spa-replay", "remediation", "report-comparison", "report-tabs", "review-fixes", "screen-reader-readiness",
  "shared-navigation", "tab-switching", "vpat", "required-fields"
];

let failed = 0;
for (const name of fixtures) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [`scripts/verify-${name}.js`], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 400_000 });
  const passed = result.status === 0;
  if (!passed) failed += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
  if (!passed) console.log(String(result.stderr || result.stdout || result.error?.message || "").trim().split(/\r?\n/).slice(-12).join("\n"));
}
console.log(failed ? `${failed} of ${fixtures.length} browser fixtures failed.` : `All ${fixtures.length} browser fixtures passed.`);
process.exitCode = failed ? 1 : 0;
