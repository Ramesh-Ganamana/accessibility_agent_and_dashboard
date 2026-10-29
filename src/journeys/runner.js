import fs from "node:fs/promises";
import path from "node:path";
import { createBrowserSession } from "../browser/session.js";
import { navigateAndWait, waitForPageReady } from "../browser/readiness.js";
import { addReviewFindingsWithEvidence, scanCurrentState, summarize } from "../scanner/crawler.js";
import { scanKeyboardFocus } from "../scanner/focus.js";
import { assistiveTechnologyMetadata } from "../scanner/screen-reader.js";
import { createEvidenceRegistry, storeDeduplicatedEvidence } from "../scanner/evidence.js";
import { writeReportCheckpoint, writeReportFiles } from "../report/export.js";
import { normalizeAuditConfiguration } from "../report/audit.js";
import { sanitizeUrl, sanitizeUrlsInText } from "../url-security.js";
import { consequentialGuard, describeTarget, loadJourney, locate, originAllowed, resolveValue } from "./journey.js";
import { actionBlockCount, actionExclusionScope, actionExclusionsFor, assertActionAllowed, assertKeyAllowed, guardedClick, isExcludedActionUrl } from "../browser/action-exclusions.js";

const STEP_TIMEOUT_MS = 15_000;

// Runs one journey file and writes a normal report (opened in the dashboard
// like any scan) with a "journey" section listing every step and checkpoint.
export async function runJourney({ file, config, onEvent = () => {} }) {
  const { journey, testData } = await loadJourney(file);
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-journey-${Math.random().toString(36).slice(2, 7)}`;
  const outputDir = path.join(config.reportsDir, runId);
  await fs.mkdir(path.join(outputDir, "evidence", "baselines"), { recursive: true });
  const report = {
    id: runId, targetUrl: sanitizeUrl(journey.startUrl), startedAt: startedAt.toISOString(), completedAt: null, status: "in-progress",
    configuration: { maxPages: 0, interactionCrawl: false, audit: normalizeAuditConfiguration(journey.audit || {}), journey: journey.name, device: journey.device === "mobile" ? "mobile (Pixel 7 emulation)" : "desktop" },
    summary: {}, pages: [], graph: { nodes: [], edges: [] }, crawlTermination: null,
    assistiveTechnology: assistiveTechnologyMetadata(), issues: [], incomplete: [], bestPractices: [], events: [],
    limitations: ["Journey results cover the scripted steps and checkpoints only; other pages and states were not crawled."],
    journey: {
      name: journey.name, description: journey.description || "", environment: journey.environment,
      authorizationRef: journey.authorization?.reference || null, approvedBy: journey.authorization?.approvedBy || null,
      file: path.basename(file), outcome: "running", steps: []
    }
  };
  const emit = (event) => {
    const enriched = { at: new Date().toISOString(), ...event, ...(event.message ? { message: sanitizeUrlsInText(event.message) } : {}), ...(event.url ? { url: sanitizeUrl(event.url) || undefined } : {}) };
    report.events.push(enriched);
    onEvent(enriched);
  };
  emit({ type: "report-started", message: `Journey “${journey.name}” started in the ${journey.environment} environment.`, reportId: runId });
  await writeReportCheckpoint(report, outputDir).catch(() => {});

  const journeyConfig = { ...config, targetUrl: journey.startUrl, aiEnabled: false, device: journey.device === "mobile" ? "mobile" : "desktop", nvda: { ...(config.nvda || {}), requested: false }, login: { ...(config.login || {}), url: "", email: "", password: "", persist: journey.useSavedSession !== false },
    // The Do not click list applies to the journey's own application: its start
    // address (with www/https variants) and its declared websites, never to
    // whatever TARGET_URL happens to name.
    excludeActionOrigin: new URL(journey.startUrl).origin,
    excludeActionOrigins: (journey.allowedOrigins || []).map((origin) => String(origin).replace(/\/$/, "")) };
  report.configuration.excludedActionLabels = journeyConfig.excludeActionLabels || [];
  report.configuration.excludedActionOrigins = actionExclusionScope(journeyConfig).origins;
  const issueKeys = new Map();
  const incompleteKeys = new Map();
  const evidenceRegistry = createEvidenceRegistry();
  let evidenceCount = 0;
  let session;
  let leftScope = null;
  try {
    session = await createBrowserSession(journeyConfig, emit);
    const page = session.page;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && !originAllowed(frame.url(), journey)) leftScope = frame.url();
    });
    await navigateAndWait(page, journey.startUrl, { timeout: 60_000, shellWaitMs: journeyConfig.appShellWaitMs ?? 90_000, settleMs: 700 });

    for (const [index, step] of journey.steps.entries()) {
      const record = { index: index + 1, action: step.action, target: describeTarget(step.target), status: "done", url: null, durationMs: 0 };
      report.journey.steps.push(record);
      const stepStarted = Date.now();
      try {
        if (leftScope) throw Object.assign(new Error(`The journey left its allowed websites (${sanitizeUrl(leftScope) || "external page"}) and was stopped.`), { blocked: true });
        emit({ type: "journey", message: `Step ${index + 1}: ${step.action}${record.target ? ` ${record.target}` : ""}${step.name ? ` ${step.name}` : ""}`, url: page.url() });
        const blockedBefore = await actionBlockCount(page);
        await runStep(page, step, record, { journey, testData, journeyConfig, report, outputDir, issueKeys, incompleteKeys, evidenceRegistry, nextEvidence: () => ++evidenceCount, emit });
        if (leftScope) throw Object.assign(new Error(`Step ${index + 1} navigated outside the allowed websites; the journey was stopped.`), { blocked: true });
        // Backstop: the page guard cancelled an activation the step caused.
        if (await actionBlockCount(page) > blockedBefore) throw Object.assign(new Error("The step reached a control on the application's Do not click list and was not performed."), { blocked: true });
      } catch (error) {
        record.status = error.blocked || error.code === "USER_EXCLUDED_ACTION" ? "blocked" : "failed";
        record.error = sanitizeUrlsInText(String(error.message || error).split("\nCall log:", 1)[0]).slice(0, 500);
        report.journey.outcome = record.status;
        emit({ type: "journey-warning", message: `Step ${index + 1} ${record.status}: ${record.error}` });
        break;
      } finally {
        record.url = sanitizeUrl(page.url()) || null;
        record.durationMs = Date.now() - stepStarted;
      }
    }
    if (report.journey.outcome === "running") report.journey.outcome = "completed";
    report.graph.nodes = report.pages.map((entry, position) => ({ id: entry.url + "#" + position, label: entry.title, url: entry.url, depth: position, issueCount: entry.issueIds.length, status: "scanned", state: "page", findingState: entry.checkpointState }));
    report.graph.edges = report.graph.nodes.slice(1).map((node, position) => ({ source: report.graph.nodes[position].id, target: node.id, type: "journey", label: "next checkpoint" }));
    report.crawlTermination = { reason: `journey_${report.journey.outcome}`, message: `Journey ${report.journey.outcome} after ${report.journey.steps.length} of ${journey.steps.length} step(s); ${report.pages.length} checkpoint(s) scanned.` };
    report.completedAt = new Date().toISOString();
    report.status = "complete";
    report.summary = { ...summarize(report), journeyOutcome: report.journey.outcome, journeySteps: journey.steps.length, journeyStepsCompleted: report.journey.steps.filter((entry) => entry.status === "done").length };
    await writeReportFiles(report, outputDir);
    emit({ type: "complete", message: `Journey ${report.journey.outcome}: ${report.issues.length} confirmed findings and ${report.incomplete.length} items requiring review across ${report.pages.length} checkpoint(s).`, reportId: runId });
    return report;
  } catch (error) {
    report.status = "failed";
    report.failure = sanitizeUrlsInText(String(error?.message || error).split("\nCall log:", 1)[0]).slice(0, 1_000);
    report.journey.outcome = "failed";
    report.summary = summarize(report);
    await writeReportCheckpoint(report, outputDir).catch(() => {});
    throw error;
  } finally {
    await session?.close().catch(() => {});
  }
}

async function runStep(page, step, record, context) {
  const { journey, testData } = context;
  const settle = () => waitForPageReady(page, { timeout: STEP_TIMEOUT_MS, settleMs: 500 }).catch(() => {});
  switch (step.action) {
    case "goto": {
      const url = new URL(step.url, journey.startUrl).href;
      if (!originAllowed(url, journey)) throw Object.assign(new Error("goto target is outside allowedOrigins."), { blocked: true });
      if (isExcludedActionUrl(url, actionExclusionsFor(context.journeyConfig, url))) throw Object.assign(new Error("goto target is on the application's Do not click list."), { blocked: true });
      await navigateAndWait(page, url, { timeout: 60_000, shellWaitMs: context.journeyConfig.appShellWaitMs ?? 90_000, settleMs: 700 });
      return;
    }
    case "click": {
      const locator = locate(page, step.target);
      await locator.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
      const label = await locator.evaluate((element) => (element.getAttribute("aria-label") || element.innerText || element.value || element.getAttribute("title") || "").replace(/\s+/g, " ").trim()).catch(() => "");
      const blocked = consequentialGuard(step, label, journey);
      if (blocked) throw Object.assign(new Error(blocked), { blocked: true });
      record.label = label.slice(0, 120);
      record.consequential = step.consequential === true;
      // Refused (step "blocked") when the control is on the Do not click list.
      await guardedClick(locator, { timeout: STEP_TIMEOUT_MS });
      await settle();
      return;
    }
    case "fill": {
      const { resolved, masked } = resolveValue(step.value, testData);
      const locator = locate(page, step.target);
      await locator.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
      await assertActionAllowed(locator);
      await locator.fill(resolved, { timeout: STEP_TIMEOUT_MS });
      record.value = masked;
      return;
    }
    case "select": {
      const { resolved, masked } = resolveValue(step.value, testData);
      const locator = locate(page, step.target);
      await locator.waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
      await assertActionAllowed(locator);
      await locator.selectOption({ label: resolved }, { timeout: STEP_TIMEOUT_MS }).catch(() => locator.selectOption(resolved, { timeout: STEP_TIMEOUT_MS }));
      record.value = masked;
      return;
    }
    case "check":
    case "uncheck": {
      const locator = locate(page, step.target);
      await locator.waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
      await assertActionAllowed(locator);
      await (step.action === "check" ? locator.check({ timeout: STEP_TIMEOUT_MS }) : locator.uncheck({ timeout: STEP_TIMEOUT_MS }));
      return;
    }
    case "press": {
      // A key on a focused listed control (or Enter through a listed default
      // button) is refused like a click.
      await assertKeyAllowed(page, step.key);
      // Enter inside a form submits it, so it is held to the consequential rule.
      const inForm = await page.evaluate(() => Boolean(document.activeElement?.closest("form"))).catch(() => false);
      if (step.key === "Enter" && inForm) {
        const blocked = consequentialGuard(step, "Submit (Enter in a form)", journey);
        if (blocked) throw Object.assign(new Error(blocked), { blocked: true });
      }
      await page.keyboard.press(step.key);
      await settle();
      return;
    }
    case "waitFor":
    case "assert": {
      const timeout = step.action === "assert" ? 5_000 : Number(step.timeoutMs) || STEP_TIMEOUT_MS;
      if (step.url) await page.waitForURL((url) => url.href.includes(step.url), { timeout });
      if (step.text) await page.getByText(step.text, { exact: step.exact === true }).first().waitFor({ state: "visible", timeout });
      return;
    }
    case "checkpoint":
      await runCheckpoint(page, step, context);
      return;
    default:
      throw new Error(`Unsupported action ${step.action}.`);
  }
}

async function runCheckpoint(page, step, { report, outputDir, issueKeys, incompleteKeys, evidenceRegistry, nextEvidence, journeyConfig, emit }) {
  const state = `journey:${String(step.name).slice(0, 60)}`;
  const url = sanitizeUrl(page.url()) || page.url();
  const pageRecord = {
    url, title: `${step.name}`, checkpointState: state, depth: report.pages.length, statusCode: null, actualUrl: url,
    navigationActions: [], observedStates: [], stateEdges: [], issueIds: [], incompleteIds: [], bestPracticeIds: [], skippedFrames: [],
    screenReaderStates: [], ruleOutcomes: [], crawlStatus: "scanned", technology: {}, baseline: null, error: null
  };
  const buffer = await page.screenshot({ fullPage: false });
  pageRecord.baseline = (await storeDeduplicatedEvidence({ outputDir, relativeDir: "evidence/baselines", fileName: `${String(report.pages.length + 1).padStart(3, "0")}-checkpoint.png`, buffer, registry: evidenceRegistry })).path;
  await scanCurrentState({ page, url, state, outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex: nextEvidence, evidenceRegistry, config: journeyConfig });
  if (step.keyboard !== false) {
    const findings = (await scanKeyboardFocus(page, url, journeyConfig.keyboardMaxTabs ?? 120)).map((finding) => ({ ...finding, state: `${state}:${finding.state}` }));
    await addReviewFindingsWithEvidence({ findings, page, frame: page.mainFrame(), outputDir, report, pageRecord, incompleteKeys, getEvidenceIndex: nextEvidence, evidenceRegistry });
  }
  report.pages.push(pageRecord);
  emit({ type: "journey", message: `Checkpoint “${step.name}” scanned: ${pageRecord.issueIds.length} confirmed, ${pageRecord.incompleteIds.length} to review.`, url });
  await writeReportCheckpoint(report, outputDir).catch(() => {});
}

export async function listJourneys(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const journeys = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(directory, entry.name);
    try {
      const { journey } = await loadJourney(file);
      journeys.push({ file: entry.name, name: journey.name, environment: journey.environment, startUrl: sanitizeUrl(journey.startUrl), steps: journey.steps.length, valid: true });
    } catch (error) {
      journeys.push({ file: entry.name, valid: false, error: String(error.message || error).slice(0, 600) });
    }
  }
  return journeys;
}
