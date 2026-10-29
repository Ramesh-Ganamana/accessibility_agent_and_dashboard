import { scanFrameWithAxe } from "../axe.js";
import { captureScreenReaderSnapshot } from "../screen-reader.js";
import { detectPageAccessFailure } from "../../browser/readiness.js";
import { addReviewFindingsWithEvidence, addFindingsWithEvidence } from "./findings.js";
import { isFirstPartyFrame, safeOriginOf } from "./navigation.js";

export async function scanCurrentState({ page, url, state, outputDir, report, pageRecord, issueKeys, incompleteKeys, getEvidenceIndex, evidenceRegistry, config = {} }) {
  const accessFailure = await detectPageAccessFailure(page);
  if (accessFailure) {
    report.limitations.push(`${url} (${state}): application returned ${accessFailure}; this state was not evaluated.`);
    return;
  }
  for (const frame of page.frames()) {
    // Ads, video players, chat widgets and CAPTCHA frames belong to other sites.
    if (!config.scanThirdPartyFrames && !isFirstPartyFrame(frame, page, report.targetUrl)) {
      const origin = safeOriginOf(frame.url());
      if (origin && !pageRecord.skippedFrames?.includes(origin)) pageRecord.skippedFrames?.push(origin);
      continue;
    }
    const screenReaderState = await captureScreenReaderSnapshot(page, frame, url, state);
    const screenReaderKey = `${screenReaderState.frameUrl}|${screenReaderState.state}`;
    if (!pageRecord.screenReaderStates.some((entry) => `${entry.frameUrl}|${entry.state}` === screenReaderKey)) {
      pageRecord.screenReaderStates.push(screenReaderState);
    }
    const result = await scanFrameWithAxe(frame, url, state, report.configuration.audit);
    if (result.testOutcomes) pageRecord.ruleOutcomes.push(result.testOutcomes);
    if (result.limitation) report.limitations.push(`${frame.url() || "unnamed frame"}: ${result.limitation}`);
    await addFindingsWithEvidence({ findings: result.violations, page, frame, outputDir, report, pageRecord, issueKeys, getEvidenceIndex, evidenceRegistry });
    await addReviewFindingsWithEvidence({ findings: result.incomplete, page, frame, outputDir, report, pageRecord, incompleteKeys, getEvidenceIndex, evidenceRegistry });
  }
}
