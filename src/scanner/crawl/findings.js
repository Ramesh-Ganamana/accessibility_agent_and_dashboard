import { captureHighlightedEvidence } from "../evidence.js";
import { safeOriginOf } from "./navigation.js";

export async function addReviewFindingsWithEvidence({ findings, page, frame, outputDir, report, pageRecord, incompleteKeys, getEvidenceIndex, evidenceRegistry }) {
  for (const finding of findings) {
    const key = findingKey(finding);
    if (incompleteKeys.has(key)) {
      recordOccurrence(incompleteKeys.get(key), finding);
      continue;
    }
    incompleteKeys.set(key, finding);
    finding.reviewStatus = "needs-review";
    finding.reviewHistory = [{
      at: new Date().toISOString(),
      status: "needs-review",
      source: finding.source || "axe-core",
      message: finding.failureSummary || finding.description || "Automated evaluation could not determine a definitive pass or failure."
    }];
    // A check that already captured its own screenshot (for example while a
    // zoom or reflow condition was applied) keeps it.
    const presetEvidence = Boolean(finding.evidence);
    if (!presetEvidence && report.incomplete.length < 80) {
      finding.evidence = await captureHighlightedEvidence({
        page,
        frame,
        target: finding.target,
        issue: finding,
        outputDir,
        index: getEvidenceIndex(),
        evidenceRegistry
      });
    }
    finding.evidenceKind = finding.evidence ? (presetEvidence && finding.evidenceKind ? finding.evidenceKind : "highlighted") : "unavailable";
    if (!finding.evidence && finding.state === "default" && pageRecord.baseline) {
      finding.contextEvidence = pageRecord.baseline;
      finding.evidenceKind = "page-context";
    }
    report.incomplete.push(finding);
    pageRecord.incompleteIds.push(finding.id);
  }
}

export async function addFindingsWithEvidence({ findings, page, frame, outputDir, report, pageRecord, issueKeys, getEvidenceIndex, evidenceRegistry }) {
  for (const finding of findings) {
    const key = findingKey(finding);
    if (issueKeys.has(key)) {
      recordOccurrence(issueKeys.get(key), finding);
      continue;
    }
    issueKeys.set(key, finding);
    // Rules without a WCAG criterion are axe best practices: kept visible in their
    // own group, but not counted as confirmed WCAG failures or scored.
    const bestPractice = !(finding.wcag || []).length;
    finding.category = bestPractice ? "best-practice" : "wcag";
    const collection = bestPractice ? (report.bestPractices ||= []) : report.issues;
    if (collection.length < (bestPractice ? 40 : 80)) {
      finding.evidence = await captureHighlightedEvidence({
        page,
        frame,
        target: finding.target,
        issue: finding,
        outputDir,
        index: getEvidenceIndex(),
        evidenceRegistry
      });
    }
    finding.evidenceKind = finding.evidence ? "highlighted" : "unavailable";
    collection.push(finding);
    (bestPractice ? (pageRecord.bestPracticeIds ||= []) : pageRecord.issueIds).push(finding.id);
  }
}

// Site-wide header/navigation/footer findings are one defect seen on many pages.
export function recordOccurrence(existing, finding) {
  if (!existing || (existing.pageUrl === finding.pageUrl && existing.state === finding.state)) return;
  existing.alsoObservedOn ||= [];
  if (existing.alsoObservedOn.length >= 100 || existing.alsoObservedOn.some((entry) => entry.pageUrl === finding.pageUrl && entry.state === finding.state)) return;
  existing.alsoObservedOn.push({ pageUrl: finding.pageUrl, state: finding.state });
}

export function findingKey(finding) {
  // A header/navigation/footer node with identical markup is the same defect on
  // every page; it is recorded once with the other pages listed.
  if (finding.region === "global") return `global|${safeOriginOf(finding.frameUrl) || ""}|${finding.ruleId}|${JSON.stringify(finding.target)}|${finding.html || ""}`;
  return `${finding.pageUrl}|${finding.frameUrl}|${finding.ruleId}|${JSON.stringify(finding.target)}`;
}
