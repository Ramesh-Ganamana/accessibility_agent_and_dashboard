import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as crawler from "../src/scanner/crawler.js";
import { runAccessibilityScan } from "../src/scanner/crawl/run.js";
import { scanCurrentState } from "../src/scanner/crawl/checks.js";
import { createCrawlQueue } from "../src/scanner/crawl/queue.js";
import { countRecordedStates, determineCrawlTermination } from "../src/scanner/crawl/reporting.js";
import * as nvda from "../src/assistive-technology/nvda.js";
import { desktopLease } from "../src/assistive-technology/nvda/desktop-lease.js";
import { createNvdaCaptureReceiver } from "../src/assistive-technology/nvda/capture-receiver.js";
import { restoreNativeScope, cleanupScopeMarker } from "../src/assistive-technology/nvda/scope-recovery.js";
import * as helperPaths from "../src/assistive-technology/nvda/paths.js";

test("old scanner and NVDA imports retain their implementation identity", () => {
  assert.equal(crawler.runAccessibilityScan, runAccessibilityScan);
  assert.equal(crawler.scanCurrentState, scanCurrentState);
  assert.equal(nvda.createNvdaCaptureReceiver, createNvdaCaptureReceiver);
  assert.deepEqual(Object.keys(crawler).sort(), ["addReviewFindingsWithEvidence", "adoptRedirectedOrigin", "runAccessibilityScan", "scanCurrentState", "summarize"]);
  for (const name of ["detectNvdaCapability", "startNvdaCaptureSession", "runNvdaWebsiteTest", "checkNvdaRunning", "warmNvdaKeyboardHelper", "waitForActionSpeech"]) assert.equal(typeof nvda[name], "function");
});

test("moved native modules resolve every helper under the repository scripts folder", async () => {
  const expected = fileURLToPath(new URL("../scripts/windows/", import.meta.url));
  assert.equal(Object.keys(helperPaths).length, 5);
  for (const helper of Object.values(helperPaths)) {
    assert.equal(path.dirname(helper), path.resolve(expected));
    assert.ok((await fs.stat(helper)).isFile());
  }
});

test("live startup, replay and helper warmup still share one desktop lease", async () => {
  assert.equal(desktopLease.active, false);
  desktopLease.active = true;
  try {
    await assert.rejects(nvda.startNvdaCaptureSession({ config: {}, outputDir: "unused" }), /Another NVDA test/);
    const replay = await nvda.runNvdaWebsiteTest({ report: {}, config: {}, outputDir: "unused" });
    assert.equal(replay.status, "blocked");
    assert.match(replay.reason, /Another NVDA website test/);
    assert.equal(nvda.warmNvdaKeyboardHelper({}), undefined);
    assert.equal(desktopLease.active, true, "a rejected runner must not release another runner's ownership");
  } finally { desktopLease.active = false; }
});

test("route queues retain exclusions, replay upgrades and per-scan isolation", () => {
  const startUrl = "https://example.test/";
  const events = [];
  const report = { pages: [], graph: { nodes: [], edges: [] } };
  const options = { startUrl, report, config: { maxDepth: 2, excludePaths: ["/logout"], excludeActionLabels: ["https://example.test/blocked"], excludeActionOrigin: startUrl }, edgeKeys: new Set(), emit: (event) => events.push(event) };
  const first = createCrawlQueue(options);
  const second = createCrawlQueue({ ...options, edgeKeys: new Set() });
  const target = "https://example.test/account";
  const replay = { baseUrl: startUrl, path: [{ label: "Account" }] };
  const blocked = { url: "https://example.test/blocked", label: "Blocked", _replay: replay };
  const upgraded = { url: target, label: "Account", _replay: replay };
  first.recordDiscoveredRoutes({ navigationActions: [{ url: target, label: "Account" }, blocked, { url: "https://example.test/logout", label: "Log out" }, upgraded], stateEdges: [] }, { url: startUrl, depth: 0 });
  assert.deepEqual(first.queue.map((entry) => entry.url), [startUrl, target]);
  assert.equal(first.queue[1].replay, replay);
  assert.equal(first.queue[1].depth, 1);
  assert.equal(events.filter((event) => event.type === "action-skip").length, 1);
  assert.ok(!Object.hasOwn(blocked, "_replay") && !Object.hasOwn(upgraded, "_replay"));
  assert.deepEqual(second.queue.map((entry) => entry.url), [startUrl]);
  assert.notEqual(first.visited, second.visited);
});

test("one-page state budgets and remaining routes remain distinct", () => {
  const url = "https://example.test/";
  const report = { pages: [{ url, observedStates: [{ id: "dialog" }], skippedRoutes: [] }] };
  assert.equal(countRecordedStates(report), 2);
  const limited = determineCrawlTermination(report, [{ url }, { url: url + "next" }], { maxPages: 1, maxStates: 2 });
  assert.equal(limited.reason, "state_limit_reached");
  assert.equal(limited.remainingRoutes, 1);
  assert.equal(determineCrawlTermination(report, [{ url }], { maxPages: 1, maxStates: 10 }).pageLimitReached, false);
});

function recoveryFixture(overrides = {}) {
  const events = [];
  const window = { processId: 123, windowHandle: "456" };
  const page = { bringToFront: async () => events.push("foreground"), evaluate: async (fn) => events.push(fn.name), url: () => "https://example.test/" };
  const capture = { control: {}, receiver: { waitForScope: async () => true }, write: async () => events.push("write-scope") };
  const runtime = { inspect: async () => ({ url: page.url(), dialogs: [] }), focusWindow: async () => ({ ok: true, ...window }), anchor: async () => true, nativeAnchor: async () => ({ ok: true }), tabActive: async () => true };
  const input = { page, window, title: "fixture", capture, runtime, controlled: true, newPage: false, applicationOrigin: "https://example.test", isClosed: () => false, isStopped: () => false, stop: async () => events.push("stop"), httpOrigin: (value) => new URL(value).origin, marker: { pinned: false }, ...overrides };
  return { input, events };
}

test("scope recovery preserves verified HWND/PID and cleans a successful marker", async () => {
  const { input, events } = recoveryFixture();
  const focused = await restoreNativeScope(input);
  assert.equal(focused.processId, 123);
  assert.equal(input.capture.control.lifecycle, "testing");
  assert.equal(input.capture.control.capture.active, false);
  assert.equal(input.marker.pinned, false);
  await cleanupScopeMarker(input.page, input.marker);
  assert.equal(events.filter((event) => event === "restoreResumeMarker").length, 1);
});

test("a refused scope keeps its marker until the caller disarms or stops", async () => {
  const { input, events } = recoveryFixture();
  input.capture.receiver.waitForScope = async () => false;
  input.capture.stoppedReason = "fixture reader stopped";
  await assert.rejects(restoreNativeScope(input), /fixture reader stopped/);
  assert.equal(input.marker.pinned, true);
  assert.ok(!events.includes("restoreResumeMarker"));
  events.push("disarm-or-stop");
  await cleanupScopeMarker(input.page, input.marker);
  assert.deepEqual(events.slice(-2), ["disarm-or-stop", "restoreResumeMarker"]);
});

test("a different native window cannot receive the existing reader scope", async () => {
  const { input, events } = recoveryFixture();
  input.runtime.focusWindow = async () => ({ ok: true, processId: 999, windowHandle: "888" });
  assert.equal(await restoreNativeScope(input), false);
  assert.ok(events.includes("stop"));
  assert.ok(!events.includes("write-scope"));
  await cleanupScopeMarker(input.page, input.marker);
});
