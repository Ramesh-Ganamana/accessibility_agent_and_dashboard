import { sanitizeUrl, sanitizeUrlsInText } from "../../url-security.js";
import { actionExclusionsFor } from "../../browser/action-exclusions.js";
import { restoreNvdaState, selectNvdaStates } from "../../assistive-technology/state-targets.js";
import { createLiveNvdaSession } from "../../assistive-technology/nvda-live.js";

// Starts NVDA once the crawl has finished, on a new tab of the same signed-in
// browser, and replays each recorded state before testing it. A state that
// cannot be reproduced is reported, never tested under the wrong label.
export async function runNvdaAfterCrawl({ config, outputDir, emit, session, report, stateTargets }) {
  session.throwIfStopped();
  const { targets, discovered, skippedByLimit } = selectNvdaStates(report, stateTargets, config.nvda?.maxStates);
  if (!targets.length) return blockedNvdaResult(new Error("No crawled page or state could be replayed for NVDA."));
  emit({ type: "nvda", message: `Crawl complete. Starting NVDA for ${targets.length} recorded state(s).` });
  const replayFailures = [];
  let live;
  let page;
  try {
    live = await (config.nvdaSessionFactory || createLiveNvdaSession)({ config, outputDir, emit });
    page = await session.newInternalPage();
    if (await live.preparePage(page) !== false) {
      for (const [index, target] of targets.entries()) {
        session.throwIfStopped();
        if (page.isClosed() || live.state === "stopped") break;
        emit({ type: "nvda", message: `Testing recorded state ${index + 1} of ${targets.length} with NVDA: ${target.state}.`, url: target.url });
        try {
          await restoreNvdaState(page, target, { excludeLabels: actionExclusionsFor(config, target.url) });
        } catch (error) {
          replayFailures.push(`${target.state} at ${sanitizeUrl(target.url) || "the recorded page"}: ${sanitizeUrlsInText(error.message)}`);
          continue;
        }
        const result = await live.testState(page, { ...target, executionMode: "after-crawl" });
        // Once the reader has stopped, later states cannot run; stop replaying.
        if (result?.error && !result.actions?.length && /closed|stopped|shutting down|unavailable/i.test(result.error)) break;
      }
    }
  } catch (error) {
    replayFailures.push(`NVDA pass: ${sanitizeUrlsInText(error.message)}`);
  }
  try {
    const result = live ? await live.finish() : blockedNvdaResult(new Error(replayFailures.at(-1) || "NVDA could not start."));
    result.executionMode = "after-crawl";
    result.coverage = { ...(result.coverage || {}), statesDiscovered: discovered, statesSkippedByLimit: Number(result.coverage?.statesSkippedByLimit || 0) + skippedByLimit, statesNotReplayed: replayFailures.length };
    result.warnings = [...(result.warnings || []), ...replayFailures.map((message) => `Not tested with NVDA because the state could not be reopened: ${message}`)];
    if (replayFailures.length) {
      result.outcome = result.actualExecution ? "needs-review" : "not-executed";
      if (!result.actualExecution && !result.reason) result.reason = `No NVDA state test completed. ${result.warnings.at(-replayFailures.length)}`;
    }
    return result;
  } finally {
    // Remove the reader's close listeners and stop its owned process BEFORE
    // closing the internal tab. Normal cleanup is not a user cancellation.
    try { await live?.close(); }
    finally { await page?.close().catch(() => {}); }
  }
}

export function blockedNvdaResult(error) {
  return {
    product: "NVDA", status: "blocked", outcome: "needs-review", actualExecution: false,
    reason: sanitizeUrlsInText(error?.message || "NVDA runner unavailable"),
    states: [], warnings: [sanitizeUrlsInText(error?.message || "NVDA runner unavailable")],
    coverage: { statesAttempted: 0, statesExecuted: 0, keyboardCommands: 0, announcementsCaptured: 0 }
  };
}

export async function testLiveNvdaState({ liveNvda, page, target, report, emit }) {
  if (!liveNvda || !target) return null;
  try {
    // The crawl is deliberately paused while the reader owns the same browser.
    // Never run keyboard commands concurrently with discovery or a page change.
    let reason;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const result = await liveNvda.testState(page, target);
      if (attempt > 0 && result?.stateChanged) {
        reason = "The interrupted application state changed and cannot be safely resumed.";
        break;
      }
      const interrupted = liveNvda.state === "paused" || result?.retryable || result?.status === "interrupted";
      if (!interrupted) return result;
      reason = result?.reason || liveNvda.pausedReason || "The NVDA state test was interrupted.";
      if (attempt === 3 || !liveNvda.resume || result?.retryable === false) break;
      emit({ type: "nvda", message: `Crawl paused. Recovering NVDA on the same state: ${target.state}.`, url: target.url });
      if (!await liveNvda.resume(page)) break;
      // No crawler actions occur between the pause, native scope handoff and
      // retry. The session verifies identity and skips completed categories.
    }
    await liveNvda.close().catch(() => {});
    throw Object.assign(new Error(`NVDA could not safely finish this state: ${reason} The crawl was stopped to preserve partial results.`), { code: "NVDA_INTERRUPTED" });
  } catch (error) {
    if (error?.code === "NVDA_INTERRUPTED") throw error;
    const message = `NVDA could not test ${target.state}: ${sanitizeUrlsInText(error.message)}`;
    report.limitations.push(message);
    emit({ type: "nvda-warning", message, url: target.url });
    return null;
  }
}
