import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { accessibleLabel, analyzeAndroidScreen, listAdbDevices, parseBounds, parseUiHierarchy, runAdb } from "../src/mobile/android.js";
import { buildAndroidReport, writeAndroidReport } from "../src/mobile/android-report.js";
import { readReport } from "../src/report/store.js";
const FIXTURE = readFileSync(new URL("./fixtures/android-screen.xml", import.meta.url), "utf8");

test("UI Automator hierarchies parse with entities, bounds and nesting", () => {
  const root = parseUiHierarchy(FIXTURE);
  assert.equal(root.attributes.rotation, "0");
  const app = root.children[1];
  assert.equal(app.children.length, 11);
  assert.equal(app.children[9].attributes.text, "Terms & conditions");
  assert.deepEqual(parseBounds("[0,60][126,186]"), { x1: 0, y1: 60, x2: 126, y2: 186, width: 126, height: 126 });
  assert.equal(parseBounds("bad"), null);
  assert.equal(accessibleLabel(app.children[4]), "Statements", "a clickable row is named by its text children");
  // Appium page source uses class names as element names.
  const appium = parseUiHierarchy('<hierarchy><android.widget.FrameLayout class="android.widget.FrameLayout" package="a.b" bounds="[0,0][10,10]"><android.widget.Button class="android.widget.Button" text="Go" package="a.b" clickable="true" bounds="[0,0][200,200]"/></android.widget.FrameLayout></hierarchy>');
  assert.equal(appium.children[0].children[0].attributes.text, "Go");
});

test("Android screen checks separate confirmed failures, review items and best practices", () => {
  const result = analyzeAndroidScreen(FIXTURE, { density: 2.625, screen: "Login" });
  assert.equal(result.packageName, "com.example.bank", "system UI is excluded");
  const rules = (type) => result.findings.filter((finding) => finding.findingType === type).map((finding) => `${finding.ruleId}@${finding.html.match(/bounds="([^"]+)"/)?.[1]}`);
  assert.deepEqual(rules("violation").sort(), [
    "android-control-no-name@[0,60][126,186]",
    "android-touch-target-too-small@[900,1220][940,1260]",
    "android-touch-target-too-small@[945,1220][985,1260]"
  ]);
  assert.deepEqual(rules("needs-review").sort(), [
    "android-clickable-not-focusable@[100,1500][900,1640]",
    "android-image-no-description@[0,880][1080,1200]",
    "android-input-no-label@[200,400][900,540]"
  ], "the icon inside the labelled Statements row is not flagged");
  const best = rules("best-practice");
  assert.ok(best.includes("android-redundant-role-in-label@[200,200][900,340]"));
  assert.ok(best.includes("android-touch-target-48dp@[100,1400][150,1450]"), "an isolated 19 dp target passes 2.5.8 by spacing but misses the 48 dp guideline");
  assert.equal(best.filter((rule) => rule.startsWith("android-duplicate-label")).length, 2);
  assert.equal(result.findings.some((finding) => finding.html.includes("[100,1980][160,2000]") && /touch-target/.test(finding.ruleId)), false, "targets clipped by a scrolling list are not measured");
  assert.equal(new Set(result.findings.map((finding) => finding.id)).size, result.findings.length);
  const missing = result.findings.find((finding) => finding.ruleId === "android-control-no-name");
  assert.deepEqual(missing.wcag, ["1.1.1", "4.1.2"]);
  assert.equal(missing.target[0], 'android.widget.ImageButton[resource-id="com.example.bank:id/menu"]');
});

test("Android reports are normal reports with per-screen evidence and audit", async () => {
  const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "android-report-"));
  try {
    const screens = [
      { name: "Login", xml: FIXTURE, screenshot: Buffer.from("png"), density: 2.625, activity: "com.example.bank/.LoginActivity", packageName: "com.example.bank" },
      { name: "", xml: FIXTURE.replace('content-desc="" clickable="true" focusable="true" bounds="[0,60][126,186]"', 'content-desc="Menu" clickable="true" focusable="true" bounds="[0,60][126,186]"'), screenshot: null, density: 2.625, activity: "com.example.bank/.HomeActivity", packageName: "com.example.bank" }
    ];
    const report = buildAndroidReport({ id: "android-fixture", screens, device: { serial: "emulator-5554", model: "Pixel 9" } });
    assert.equal(report.targetUrl, "android-app://com.example.bank/");
    assert.equal(report.pages.length, 2);
    assert.equal(report.pages[1].title, "HomeActivity");
    assert.equal(report.issues.filter((issue) => issue.ruleId === "android-control-no-name").length, 1, "the fixed menu button on screen 2 is not reported");
    assert.equal(report.issues[0].evidence, "evidence/android-screen-001.png");
    assert.equal(report.summary.androidScreens, 2);
    await writeAndroidReport(report, screens, reportsDir);
    const saved = await readReport(reportsDir, "android-fixture");
    assert.ok(saved.audit.criteria.find((criterion) => criterion.id === "4.1.2").issueCount >= 1, "findings feed the WCAG audit");
    assert.equal(await fs.readFile(path.join(reportsDir, "android-fixture", "evidence", "android-screen-001.png"), "utf8"), "png");
  } finally {
    await fs.rm(reportsDir, { recursive: true, force: true });
  }
});

test("adb helpers pass the serial and parse the device list", async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("List of devices attached\nemulator-5554          device product:sdk model:Pixel_9\nR58N offline\n\n"));
      child.emit("close", 0);
    });
    return child;
  };
  const devices = await listAdbDevices({ adb: "adb", spawnProcess });
  assert.deepEqual(devices.map((device) => [device.serial, device.state]), [["emulator-5554", "device"], ["R58N", "offline"]]);
  await runAdb(["shell", "wm", "density"], { adb: "adb", serial: "emulator-5554", spawnProcess });
  assert.deepEqual(calls.at(-1), ["-s", "emulator-5554", "shell", "wm", "density"]);
});
