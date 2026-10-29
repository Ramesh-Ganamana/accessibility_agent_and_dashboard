import test from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/config.js";

test("crawl depth zero is preserved and crawl budgets are bounded whole numbers", () => {
  assert.equal(getConfig({ maxDepth: 0 }).maxDepth, 0);
  assert.equal(getConfig({ maxDepth: "0" }).maxDepth, 0);
  assert.equal(getConfig({ maxPages: 2.8 }).maxPages, 2);
  assert.equal(getConfig({ maxPages: -5 }).maxPages, 1);
  assert.equal(getConfig({ maxPages: 999 }).maxPages, 100);
  assert.equal(getConfig({ maxDepth: 999 }).maxDepth, 8);
  assert.equal(getConfig({ maxDepth: "invalid" }).maxDepth, 3);
  assert.equal(getConfig({ maxPages: Infinity }).maxPages, 25);
  assert.equal(getConfig({ maxStates: 3.8 }).maxStates, 3);
  assert.equal(getConfig({ maxStates: -1 }).maxStates, 1);
  assert.equal(getConfig({ maxStates: 999 }).maxStates, 500);
  assert.equal(getConfig({ maxStates: Infinity }).maxStates, 100);
});

test("one-page scans retain an independent interaction-state budget", () => {
  const config = getConfig({ maxPages: 1, maxStates: 12, maxDepth: 2 });
  assert.equal(config.maxPages, 1);
  assert.equal(config.maxStates, 12);
  assert.equal(config.maxDepth, 2);
});

test("NVDA coverage uses a bounded state limit independent of page limits", () => {
  const config = getConfig({ maxPages: 1, nvda: { maxStates: 20 } });
  assert.equal(config.nvda.maxStates, 20);
  assert.equal(Object.hasOwn(config.nvda, "maxPages"), false);
  assert.equal(getConfig({ nvda: { maxStates: 900 } }).nvda.maxStates, 500);
});

test("NVDA defaults to testing live states; replay requires explicit opt-in", () => {
  const previous = process.env.NVDA_MODE;
  try {
    delete process.env.NVDA_MODE;
    assert.equal(getConfig().nvda.mode, "during-crawl");
    process.env.NVDA_MODE = "after-crawl";
    assert.equal(getConfig().nvda.mode, "after-crawl");
    assert.equal(getConfig({ nvda: { mode: "during-crawl" } }).nvda.mode, "during-crawl");
    process.env.NVDA_MODE = "invalid";
    assert.equal(getConfig().nvda.mode, "during-crawl");
    assert.equal(getConfig({ nvda: { mode: "after-crawl" } }).nvda.mode, "after-crawl");
  } finally {
    if (previous === undefined) delete process.env.NVDA_MODE;
    else process.env.NVDA_MODE = previous;
  }
});

test("NVDA startup uses a bounded readiness deadline instead of a fixed startup wait", () => {
  const previousTimeout = process.env.NVDA_STARTUP_TIMEOUT_MS;
  try {
    delete process.env.NVDA_STARTUP_TIMEOUT_MS;
    assert.equal(getConfig().nvda.startupTimeoutMs, 60000);
    assert.equal(getConfig({ nvda: { startupTimeoutMs: 1250.8 } }).nvda.startupTimeoutMs, 1250);
    assert.equal(getConfig({ nvda: { startupTimeoutMs: -1 } }).nvda.startupTimeoutMs, 1000);
    assert.equal(getConfig({ nvda: { startupTimeoutMs: 999999 } }).nvda.startupTimeoutMs, 300000);
    assert.equal(getConfig({ nvda: { startupTimeoutMs: "invalid" } }).nvda.startupTimeoutMs, 60000);
    assert.equal(getConfig({ nvda: { startupTimeoutMs: Infinity } }).nvda.startupTimeoutMs, 60000);
  } finally {
    if (previousTimeout === undefined) delete process.env.NVDA_STARTUP_TIMEOUT_MS;
    else process.env.NVDA_STARTUP_TIMEOUT_MS = previousTimeout;
  }
});

test("NVDA defaults to a listener-friendly speech rate with fast speech disabled", () => {
  const previousRate = process.env.NVDA_SPEECH_RATE;
  const previousFastSpeech = process.env.NVDA_FAST_SPEECH;
  try {
    delete process.env.NVDA_SPEECH_RATE;
    delete process.env.NVDA_FAST_SPEECH;
    assert.equal(getConfig().nvda.speechRate, 40);
    assert.equal(getConfig().nvda.fastSpeech, false);
  } finally {
    if (previousRate === undefined) delete process.env.NVDA_SPEECH_RATE;
    else process.env.NVDA_SPEECH_RATE = previousRate;
    if (previousFastSpeech === undefined) delete process.env.NVDA_FAST_SPEECH;
    else process.env.NVDA_FAST_SPEECH = previousFastSpeech;
  }
});

test("NVDA speech rate accepts environment settings and bounds invalid or excessive rates", () => {
  const previousRate = process.env.NVDA_SPEECH_RATE;
  try {
    for (const [setting, expected] of [["25", 25], ["0", 0], ["100", 100], ["42.9", 42], ["-5", 0], ["999", 100], ["invalid", 40], ["Infinity", 40], ["", 40]]) {
      process.env.NVDA_SPEECH_RATE = setting;
      assert.equal(getConfig().nvda.speechRate, expected, `Speech rate configuration: ${setting}`);
    }
  } finally {
    if (previousRate === undefined) delete process.env.NVDA_SPEECH_RATE;
    else process.env.NVDA_SPEECH_RATE = previousRate;
  }
});

test("NVDA speech overrides take precedence and explicit fast speech remains available", () => {
  const previousRate = process.env.NVDA_SPEECH_RATE;
  const previousFastSpeech = process.env.NVDA_FAST_SPEECH;
  try {
    process.env.NVDA_SPEECH_RATE = "90";
    process.env.NVDA_FAST_SPEECH = "true";
    assert.equal(getConfig().nvda.fastSpeech, true);
    const listenerConfig = getConfig({ nvda: { speechRate: 30, fastSpeech: false } });
    assert.equal(listenerConfig.nvda.speechRate, 30);
    assert.equal(listenerConfig.nvda.fastSpeech, false);
    assert.equal(getConfig({ nvda: { speechRate: 0 } }).nvda.speechRate, 0);
    assert.equal(getConfig({ nvda: { speechRate: -1 } }).nvda.speechRate, 0);
    assert.equal(getConfig({ nvda: { speechRate: 999 } }).nvda.speechRate, 100);
    assert.equal(getConfig({ nvda: { speechRate: "invalid" } }).nvda.speechRate, 40);
    process.env.NVDA_FAST_SPEECH = "false";
    assert.equal(getConfig({ nvda: { fastSpeech: true } }).nvda.fastSpeech, true);
  } finally {
    if (previousRate === undefined) delete process.env.NVDA_SPEECH_RATE;
    else process.env.NVDA_SPEECH_RATE = previousRate;
    if (previousFastSpeech === undefined) delete process.env.NVDA_FAST_SPEECH;
    else process.env.NVDA_FAST_SPEECH = previousFastSpeech;
  }
});

test("audit profile uses the same general defaults and accepts financial WCAG 2.1", () => {
  assert.deepEqual(getConfig().audit, { profile: "general", wcagVersion: "2.2", level: "AA" });
  assert.deepEqual(getConfig({ audit: { profile: "financial", wcagVersion: "2.1" } }).audit, { profile: "financial", wcagVersion: "2.1", level: "AA" });
  assert.deepEqual(getConfig({ nvda: { tests: ["focus", "focus", "reading", "unsafe"] } }).nvda.tests, ["focus", "reading"]);
  assert.equal(getConfig({ nvda: { readingTimeoutMs: 900000 } }).nvda.readingTimeoutMs, 900000);
  assert.equal(getConfig({ nvda: { readingTimeoutMs: 9999999 } }).nvda.readingTimeoutMs, 1800000);
  assert.equal(getConfig({ nvda: { headingStops: 999, tableStops: 999 } }).nvda.headingStops, 10);
  assert.equal(getConfig({ nvda: { headingStops: 999, tableStops: 999 } }).nvda.tableStops, 10);
});
