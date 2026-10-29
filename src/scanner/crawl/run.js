import fs from "node:fs/promises";
import path from "node:path";
import { createBrowserSession, ensureAuthenticated } from "../../browser/session.js";
import { consolidateDuplicateVisualFindings, createEvidenceRegistry } from "../evidence.js";
import { scanDocuments } from "../documents.js";
import { assistiveTechnologyMetadata } from "../screen-reader.js";
import { writeReportCheckpoint, writeReportFiles } from "../../report/export.js";
import { sanitizeUrl, sanitizeUrlsInText } from "../../url-security.js";
import { createLiveNvdaSession } from "../../assistive-technology/nvda-live.js";
import { normalizeAuditConfiguration } from "../../report/audit.js";
import { finalizeCrawlGraph, countRecordedStates, summarize, determineCrawlTermination } from "./reporting.js";
import { runNvdaAfterCrawl, blockedNvdaResult } from "./nvda-bridge.js";
import { scanPage } from "./page.js";
import { recordOccurrence } from "./findings.js";
import { validateTarget, cleanUrl, sameOrigin } from "./navigation.js";

import { createCrawlQueue } from "./queue.js";

export async function runAccessibilityScan(config, onEvent = () => {}) {
  // The native screen reader shares the crawler's visible desktop. Injected
  // runners/factories retain their browser setting for isolated test fixtures.
  const liveNvdaRequested = Boolean(config.nvda?.requested && !config.nvdaRunner);
  if (liveNvdaRequested && !config.nvdaSessionFactory) config = { ...config, headless: false };
  // Default to the live, serialized scan -> NVDA -> next-state workflow.
  // Reopening a state on a second tab is only an explicitly selected fallback.
  const nvdaAfterCrawl = liveNvdaRequested && config.nvda?.mode === "after-crawl";
  if (nvdaAfterCrawl) config = { ...config, nvdaCollectTargets: true };
  const maxStates = Math.min(500, Math.max(1, Math.trunc(Number(config.maxStates) || 100)));
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
  const outputDir = path.join(config.reportsDir, runId);
  await fs.mkdir(path.join(outputDir, "evidence", "baselines"), { recursive: true });

  const startUrl = validateTarget(config.targetUrl);
  const report = {
    id: runId,
    targetUrl: startUrl,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    status: "in-progress",
    configuration: {
      maxPages: config.maxPages,
      maxStates,
      maxDepth: config.maxDepth,
      aiEnabled: config.aiEnabled,
      headless: config.headless,
      interactionCrawl: true,
      excludedActionLabels: config.excludeActionLabels,
      excludedActionOrigin: config.excludeActionOrigin,
      actionPolicy: "safe-clicks-with-destructive-and-form-submit-exclusions",
      nvdaRequested: Boolean(config.nvda?.requested),
      nvdaMode: config.nvda?.requested ? (nvdaAfterCrawl || config.nvdaRunner ? "after-crawl" : "during-crawl") : null,
      device: config.device === "mobile" && !config.nvda?.requested ? "mobile (Pixel 7 emulation)" : "desktop",
      audit: normalizeAuditConfiguration(config.audit)
    },
    summary: {},
    pages: [],
    graph: { nodes: [], edges: [] },
    crawlTermination: null,
    assistiveTechnology: assistiveTechnologyMetadata(),
    issues: [],
    incomplete: [],
    // axe best-practice rules with no WCAG mapping: shown, never scored or
    // counted as confirmed WCAG findings.
    bestPractices: [],
    events: [],
    limitations: [
      "Closed Shadow DOM internals cannot be inspected by browser automation or injected page scripts.",
      "Cross-origin frames are attempted independently; browser/site policy, authentication, or frame detachment can still prevent a complete scan.",
      "Clickable controls without a usable label, disabled or covered controls, mutating form controls, and destructive actions are not invoked automatically.",
      "Automated testing cannot prove full WCAG conformance; manual assistive-technology review remains necessary."
    ]
  };

  const emit = (event) => {
    const enriched = {
      at: new Date().toISOString(),
      ...event,
      ...(event.message ? { message: sanitizeUrlsInText(event.message) } : {}),
      ...(event.url ? { url: sanitizeUrl(event.url) || undefined } : {})
    };
    report.events.push(enriched);
    onEvent(enriched);
  };

  emit({ type: "report-started", message: "Scan report created.", reportId: runId });
  // An early checkpoint means a crash or restart leaves an inspectable partial report.
  await writeReportCheckpoint(report, outputDir).catch(() => {});
  let session;
  const issueKeys = new Map();
  const incompleteKeys = new Map();
  const edgeKeys = new Set();
  const evidenceRegistry = createEvidenceRegistry();
  const nvdaStateTargets = [];
  // Header/navigation interaction states seen on one page are linked, not
  // re-scanned, on every later page.
  const globalStates = new Map();
  // Original document links (possibly signed) stay in memory, never in the report.
  const documentDownloads = new Map();
  let liveNvda = null;
  let liveNvdaFailure = null;
  let evidenceCount = 0;

  const { queue, queued, visited, recordDiscoveredRoutes, scanOpenedTab } = createCrawlQueue({
    startUrl, config, report, maxStates, outputDir, emit, issueKeys, incompleteKeys, edgeKeys,
    evidenceRegistry, nvdaStateTargets, globalStates, documentDownloads,
    getEvidenceIndex: () => ++evidenceCount, getSession: () => session, getLiveNvda: () => liveNvda
  });

  try {
    if (liveNvdaRequested && !nvdaAfterCrawl) {
      try {
        const factory = config.nvdaSessionFactory || createLiveNvdaSession;
        liveNvda = await factory({ config, outputDir, emit });
      } catch (error) {
        liveNvdaFailure = blockedNvdaResult(error);
        emit({ type: "nvda-warning", message: `Live NVDA could not initialize; the accessibility crawl will continue: ${liveNvdaFailure.reason}` });
      }
    }
    session = await createBrowserSession(config, emit);
    if (liveNvda) {
      try {
        // Native document-focus preparation is allowed only on the blank
        // preparation page, before login or any real application navigation.
        await liveNvda.preparePage(session.page);
      } catch (error) {
        liveNvdaFailure = blockedNvdaResult(error);
        await liveNvda?.close().catch(() => {});
        liveNvda = null;
        emit({ type: "nvda-warning", message: `Live NVDA could not start; the accessibility crawl will continue: ${liveNvdaFailure.reason}` });
      }
    }
    const authenticated = await ensureAuthenticated(session, config, emit);
    session.throwIfStopped();
    let reuseAuthenticatedPage = authenticated && sameOrigin(startUrl, session.page.url());

    while (queue.length && report.pages.length < config.maxPages && countRecordedStates(report) < maxStates) {
      session.throwIfStopped();
      const item = queue.shift();
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      emit({ type: "progress", message: `Scanning ${item.url}`, current: report.pages.length + 1, total: config.maxPages, url: item.url });

      const pageRecord = await scanPage({
        page: session.page,
        session,
        url: item.url,
        replay: item.replay,
        reuseCurrentPage: reuseAuthenticatedPage && item.depth === 0,
        depth: item.depth,
        outputDir,
        config,
        emit,
        report,
        issueKeys,
        incompleteKeys,
        edgeKeys,
        stateBudget: Math.max(1, maxStates - countRecordedStates(report)),
        remainingPageSlots: Math.max(0, config.maxPages - report.pages.length - 1),
        pendingRoutes: queue.map((entry) => entry.url),
        knownPageUrls: new Set([...report.pages.flatMap((entry) => [entry.url, entry.actualUrl]), item.url].filter(Boolean)),
        getEvidenceIndex: () => ++evidenceCount,
        evidenceRegistry,
        nvdaStateTargets,
        liveNvda,
        globalStates,
        documentDownloads,
        scanOpenedTab
      });
      reuseAuthenticatedPage = false;
      // A redirected start address (feuji.com → www.feuji.com/) was scanned
      // under its requested URL; its landing URL must not be queued again.
      if (item.relation === "start" && pageRecord.actualUrl && pageRecord.actualUrl !== item.url) {
        visited.add(pageRecord.actualUrl);
        queued.add(pageRecord.actualUrl);
      }
      await writeReportCheckpoint(report, outputDir).catch(() => {});

      recordDiscoveredRoutes(pageRecord, item);
      session.throwIfStopped();

      for (const popup of [...session.popupPages]) {
        if (popup === session.page || popup.isClosed()) continue;
        const opener = await popup.opener();
        if (opener && !opener.isClosed()) await scanOpenedTab({ opener, popup, source: cleanUrl(opener.url()) || item.url, depth: item.depth + 1 });
        else { await popup.close().catch(() => {}); session.popupPages.delete(popup); }
      }
    }

    session.throwIfStopped();
    if (Number(config.documentsMax ?? 10) > 0 && report.documents?.discovered.length) {
      const documentFindings = await scanDocuments(session.context, report, { maxDocuments: Number(config.documentsMax ?? 10), emit, downloadUrls: documentDownloads, excludeLabels: config.excludeActionLabels || [] });
      for (const finding of documentFindings) {
        const key = `document|${finding.documentUrl}|${finding.ruleId}`;
        if (incompleteKeys.has(key)) { recordOccurrence(incompleteKeys.get(key), finding); continue; }
        incompleteKeys.set(key, finding);
        finding.reviewStatus = "needs-review";
        finding.reviewHistory = [{ at: new Date().toISOString(), status: "needs-review", source: "pdf-check", message: finding.description }];
        finding.evidenceKind = "unavailable";
        report.incomplete.push(finding);
        report.pages.find((entry) => sanitizeUrl(entry.actualUrl || entry.url) === finding.pageUrl || entry.url === finding.pageUrl)?.incompleteIds.push(finding.id);
      }
      await writeReportCheckpoint(report, outputDir).catch(() => {});
    }
    const duplicateEvidenceFindingsMerged = consolidateDuplicateVisualFindings(report);
    const skippedFrameOrigins = [...new Set(report.pages.flatMap((page) => page.skippedFrames || []))];
    if (skippedFrameOrigins.length) {
      report.limitations.push(`${skippedFrameOrigins.length} third-party frame origin(s) were not scanned (${skippedFrameOrigins.slice(0, 5).join(", ")}${skippedFrameOrigins.length > 5 ? ", …" : ""}). Set SCAN_THIRD_PARTY_FRAMES=true to include embedded services.`);
    }
    report.crawlTermination = determineCrawlTermination(report, queue, { ...config, maxStates });
    emit({
      type: "crawl-termination",
      message: report.crawlTermination.message,
      reason: report.crawlTermination.reason,
      remainingRoutes: report.crawlTermination.remainingRoutes
    });
    finalizeCrawlGraph(report);
    if (config.nvda?.requested) {
      let nvdaResult;
      try {
        if (nvdaAfterCrawl) {
          nvdaResult = await runNvdaAfterCrawl({ config, outputDir, emit, session, report, stateTargets: nvdaStateTargets });
        } else if (liveNvdaRequested) {
          nvdaResult = liveNvdaFailure || await liveNvda.finish();
        } else {
          // Compatibility seam for explicitly injected historical replay
          // runners. Normal scans no longer launch a post-crawl browser.
          const storageState = await session.context.storageState().catch(() => null);
          nvdaResult = await config.nvdaRunner({ report, config, storageState, stateTargets: nvdaStateTargets, outputDir, emit });
        }
      } catch (error) {
        nvdaResult = blockedNvdaResult(error);
      }
      report.assistiveTechnology.actualRuns.NVDA = nvdaResult;
      report.assistiveTechnology.actualScreenReaders.NVDA = nvdaResult.status || "not-run";
      emit({
        type: "nvda-complete",
        message: nvdaResult.actualExecution
          ? `NVDA testing captured ${nvdaResult.coverage?.announcementsCaptured || 0} announcement(s).`
          : `NVDA testing was not executed: ${nvdaResult.reason || "the configured runner was unavailable"}.`
      });
    }
    session.throwIfStopped();
    report.completedAt = new Date().toISOString();
    report.status = "complete";
    report.summary = { ...summarize(report), duplicateEvidenceFindingsMerged };
    await writeReportFiles(report, outputDir);
    emit({ type: "complete", message: `Scan completed with ${report.issues.length} confirmed findings and ${report.incomplete.length} items requiring review.`, reportId: runId });
    return report;
  } catch (error) {
    const nvdaInterrupted = error?.code === "NVDA_INTERRUPTED";
    report.status = nvdaInterrupted ? "stopped" : "failed";
    report.completedAt = new Date().toISOString();
    report.failure = sanitizeUrlsInText(String(error?.message || error).split("\nCall log:", 1)[0]).slice(0, 1_000);
    if (nvdaInterrupted) {
      report.stoppedAt = report.completedAt;
      report.stopReason = { code: error.code, message: report.failure };
      report.crawlTermination = { reason: "nvda_interrupted", message: report.failure, remainingRoutes: queue.length };
      delete report.failure;
    }
    if (session?.isStopped()) {
      report.crawlTermination = { reason: "test_browser_closed", message: report.failure, remainingRoutes: queue.length };
    }
    if (config.nvda?.requested && !report.assistiveTechnology.actualRuns.NVDA) {
      // Preserve the scan's original error even if a failed adapter cannot finish.
      let result = liveNvdaFailure || blockedNvdaResult(error);
      if (liveNvda) {
        try { result = await liveNvda.finish(); } catch {}
      }
      report.assistiveTechnology.actualRuns.NVDA = result;
      report.assistiveTechnology.actualScreenReaders.NVDA = result.status || "blocked";
    }
    report.summary = summarize(report);
    if (nvdaInterrupted) {
      finalizeCrawlGraph(report);
      emit({ type: "scan-stopped", message: `${report.stopReason.message} Partial evidence was saved; remaining states were not crawled.`, reportId: runId, reason: "nvda_interrupted" });
      await writeReportFiles(report, outputDir);
      return report;
    }
    await writeReportCheckpoint(report, outputDir).catch(() => {});
    throw error;
  } finally {
    await liveNvda?.close().catch(() => {});
    await session?.close().catch(() => {});
  }
}
