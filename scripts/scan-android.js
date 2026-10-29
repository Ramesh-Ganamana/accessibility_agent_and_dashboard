import readline from "node:readline/promises";
import { getConfig } from "../src/config.js";
import { captureAndroidScreen, listAdbDevices, runAdb } from "../src/mobile/android.js";
import { buildAndroidReport, writeAndroidReport } from "../src/mobile/android-report.js";

// Scans the screens shown on a connected Android device or emulator. The tool
// only reads the screen; you navigate the app yourself between captures.
//   npm run scan:android -- [--screens 3] [--serial emulator-5554] [--package com.example.app] [--names "Login,Home,Statements"] [--profile financial]
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const screensWanted = Math.max(1, Math.min(30, Number(option("screens", 1)) || 1));
const names = String(option("names", "")).split(",").map((value) => value.trim()).filter(Boolean);

let devices;
try { devices = await listAdbDevices(); }
catch (error) {
  console.error(`adb is not available (${error.message}). Install Android platform-tools or set ANDROID_HOME.`);
  process.exit(1);
}
const ready = devices.filter((device) => device.state === "device");
const serial = option("serial", ready[0]?.serial);
if (!serial || !ready.some((device) => device.serial === serial)) {
  console.error(ready.length ? `Device ${serial} is not connected. Connected: ${ready.map((device) => device.serial).join(", ")}` : "No Android device or emulator is connected. Start one (for example: emulator -avd Pixel_9_API_35) and unlock it.");
  process.exit(1);
}
const model = (await runAdb(["shell", "getprop", "ro.product.model"], { serial }).catch(() => "")).trim();
const release = (await runAdb(["shell", "getprop", "ro.build.version.release"], { serial }).catch(() => "")).trim();
const config = getConfig();
const prompt = screensWanted > 1 ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const screens = [];
const startedAt = new Date();
try {
  for (let index = 0; index < screensWanted; index += 1) {
    if (index > 0) await prompt.question(`Open screen ${index + 1}${names[index] ? ` (${names[index]})` : ""} on the device, then press Enter to capture it… `);
    const screen = await captureAndroidScreen({ serial });
    if (option("package")) screen.packageName = option("package");
    screens.push({ ...screen, name: names[index] || "" });
    console.log(`Captured screen ${index + 1}: ${screen.activity || "unknown activity"}`);
  }
} finally {
  prompt?.close();
}
const id = `${startedAt.toISOString().replace(/[:.]/g, "-")}-android-${Math.random().toString(36).slice(2, 7)}`;
const report = buildAndroidReport({ id, screens, device: { serial, model, androidVersion: release }, audit: { profile: option("profile", "general"), wcagVersion: option("wcag", "2.2") }, startedAt });
const outputDir = await writeAndroidReport(report, screens, config.reportsDir);
console.log(`Android report ${id}: ${report.issues.length} confirmed, ${report.incomplete.length} need review, ${report.bestPractices.length} best-practice findings across ${screens.length} screen(s).`);
console.log(`Saved to ${outputDir}. Open it from the dashboard's report list.`);
