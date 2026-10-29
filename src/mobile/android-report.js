import fs from "node:fs/promises";
import path from "node:path";
import { analyzeAndroidScreen } from "./android.js";
import { normalizeAuditConfiguration } from "../report/audit.js";
import { writeReportFiles } from "../report/export.js";
import { summarize } from "../scanner/crawler.js";

const LIMITATIONS = [
  "Native Android checks read the UI Automator hierarchy of the captured screens only; other screens, states and orientations were not tested.",
  "The hierarchy does not expose colours, text size, labelFor links or importantForAccessibility, so contrast, scaling and some labels need manual review.",
  "No TalkBack, Switch Access or keyboard session was run by these checks; screen-reader behaviour must be verified on a device."
];

// screens: [{ name, xml, screenshot (Buffer|null), density, activity, packageName }]
export function buildAndroidReport({ id, screens, device = {}, audit = {}, startedAt = new Date(), completedAt = new Date() }) {
  const packageName = screens.map((screen) => screen.packageName).find(Boolean) || "unknown.app";
  const base = `android-app://${packageName}/`;
  const report = {
    id, targetUrl: base, startedAt: new Date(startedAt).toISOString(), completedAt: new Date(completedAt).toISOString(), status: "complete",
    configuration: { platform: "android", device: `${device.model || "Android device"}${device.serial ? ` (${device.serial})` : ""}`, interactionCrawl: false, maxPages: screens.length, audit: normalizeAuditConfiguration(audit) },
    summary: {}, pages: [], graph: { nodes: [], edges: [] }, crawlTermination: null,
    issues: [], incomplete: [], bestPractices: [], events: [], limitations: LIMITATIONS,
    android: { packageName, device, screens: [] }
  };
  for (const [index, screen] of screens.entries()) {
    const name = screen.name || screen.activity?.split("/").pop().split(".").pop() || `Screen ${index + 1}`;
    const url = `${base}screen-${index + 1}`;
    const analysis = analyzeAndroidScreen(screen.xml, { density: screen.density, packageName: screen.packageName || packageName, screen: name, screenUrl: url });
    const evidence = screen.screenshot ? path.posix.join("evidence", `android-screen-${String(index + 1).padStart(3, "0")}.png`) : null;
    const page = { url, title: name, depth: 0, statusCode: null, issueIds: [], incompleteIds: [], bestPracticeIds: [], observedStates: [{ label: name, kind: "screen" }], technology: {}, crawlStatus: "scanned", screenshot: evidence };
    for (const finding of analysis.findings) {
      const entry = { ...finding, ...(evidence ? { evidence, evidenceKind: "screen" } : {}) };
      if (finding.findingType === "violation") { report.issues.push(entry); page.issueIds.push(entry.id); }
      else if (finding.findingType === "needs-review") { report.incomplete.push({ ...entry, reviewStatus: "needs-review" }); page.incompleteIds.push(entry.id); }
      else { report.bestPractices.push(entry); page.bestPracticeIds.push(entry.id); }
    }
    report.pages.push(page);
    report.graph.nodes.push({ id: url, label: name });
    if (index > 0) report.graph.edges.push({ from: report.pages[index - 1].url, to: url, label: "next captured screen" });
    report.android.screens.push({ name, activity: screen.activity || "", density: analysis.density, elements: analysis.elements, interactiveElements: analysis.interactiveElements, evidence });
  }
  report.summary = { ...summarize(report), androidScreens: screens.length };
  return report;
}

export async function writeAndroidReport(report, screens, reportsDir) {
  const outputDir = path.join(reportsDir, report.id);
  await fs.mkdir(path.join(outputDir, "evidence"), { recursive: true });
  for (const [index, screen] of screens.entries()) {
    const evidence = report.android.screens[index]?.evidence;
    if (evidence && screen.screenshot) await fs.writeFile(path.join(outputDir, ...evidence.split("/")), screen.screenshot);
    await fs.writeFile(path.join(outputDir, `android-screen-${String(index + 1).padStart(3, "0")}.xml`), screen.xml, "utf8");
  }
  await writeReportFiles(report, outputDir);
  return outputDir;
}
