const IMPACT_WEIGHT = Object.freeze({ critical: 2.4, serious: 1.3, moderate: 0.55, minor: 0.2 });
const PRINCIPLES = Object.freeze([
  { id: "1", label: "Perceivable" },
  { id: "2", label: "Operable" },
  { id: "3", label: "Understandable" },
  { id: "4", label: "Robust" }
]);

// Normalized by successfully scanned pages, not states: findings are recorded
// once per page (and once per site for shared navigation), so counting extra or
// duplicate interaction states must never improve the score.
const PAGE_TOLERANCE = 10;

function roundedScore(weight, scannedPages) {
  return Math.round(100 * Math.exp(-weight / (Math.max(1, scannedPages) * PAGE_TOLERANCE))) / 10;
}

export function isBestPracticeFinding(finding) {
  return finding?.category === "best-practice"
    || (!(finding?.wcag || []).length && (finding?.tags || []).includes("best-practice"));
}

function gradeFor(score) {
  if (score >= 9.5) return "A+";
  if (score >= 8.5) return "A";
  if (score >= 7) return "B";
  if (score >= 5.5) return "C";
  if (score >= 4) return "D";
  return "F";
}

export function assessReport(report) {
  const pages = Array.isArray(report?.pages) ? report.pages : [];
  const allIssues = Array.isArray(report?.issues) ? report.issues : [];
  // Older reports stored best-practice rules among confirmed issues.
  const findings = allIssues.filter((finding) => !isBestPracticeFinding(finding));
  const bestPracticeCount = allIssues.length - findings.length + (Array.isArray(report?.bestPractices) ? report.bestPractices.length : 0);
  const pending = Array.isArray(report?.incomplete) ? report.incomplete : [];
  const scannedPages = pages.filter((page) => !page.error).length;
  const failedPages = pages.length - scannedPages;
  const failedStates = pages.filter((page) => page.error)
    .reduce((sum, page) => sum + 1 + (page.observedStates?.length || 0), 0);
  const reportedStates = Number(report?.summary?.statesObserved);
  const observedStates = pages.length && pages.every((page) => Array.isArray(page.observedStates))
    ? pages.filter((page) => !page.error).reduce((sum, page) => sum + 1 + page.observedStates.length, 0)
    : Math.max(0, (Number.isFinite(reportedStates) && reportedStates > 0
      ? reportedStates
      : report?.graph?.nodes?.length || pages.length) - failedStates);
  const byImpact = Object.fromEntries(Object.keys(IMPACT_WEIGHT).map((impact) => [impact, 0]));
  for (const finding of findings) {
    const impact = String(finding?.impact || "").toLowerCase();
    if (Object.hasOwn(byImpact, impact)) byImpact[impact] += 1;
  }
  const weightedFindings = Object.entries(byImpact).reduce((sum, [impact, count]) => sum + IMPACT_WEIGHT[impact] * count, 0);
  const available = Boolean(report?.completedAt && scannedPages > 0 && observedStates > 0);
  const score = available ? roundedScore(weightedFindings, scannedPages) : null;
  const grade = score == null ? "—" : gradeFor(score);
  const confidence = failedPages || pending.length ? "Limited" : "Coverage-dependent";
  const principles = PRINCIPLES.map(({ id, label }) => {
    const matching = findings.filter((finding) => (finding?.wcag || []).some((criterion) => String(criterion).startsWith(`${id}.`)));
    const weight = matching.reduce((sum, finding) => sum + (IMPACT_WEIGHT[String(finding?.impact || "").toLowerCase()] || 0), 0);
    return { id, label, score: available ? roundedScore(weight, scannedPages) : null, confirmedIssues: matching.length };
  });
  return {
    score,
    outOf: 10,
    grade,
    label: "Observed accessibility health",
    status: available ? "provisional" : "unavailable",
    confidence,
    coverage: { scannedPages, attemptedPages: pages.length, failedPages, observedStates },
    counts: { confirmedIssues: findings.length, needsReview: pending.length, bestPractices: bestPracticeCount, byImpact },
    principles,
    methodology: {
      version: 2,
      formula: `10 × exp(−weighted confirmed WCAG findings ÷ (${PAGE_TOLERANCE} × successfully scanned pages))`,
      severityWeights: IMPACT_WEIGHT,
      gradeThresholds: { "A+": 9.5, A: 8.5, B: 7, C: 5.5, D: 4, F: 0 },
      note: "A heuristic for observed scan results, not a WCAG conformance score. Undetected issues may remain. Review items and best-practice findings are not counted. Scores from before version 2 were normalized by interaction states and are not directly comparable."
    }
  };
}

export function reportSection(report, section) {
  switch (section) {
    case "overview": return {
      id: report.id, targetUrl: report.targetUrl, startedAt: report.startedAt,
      completedAt: report.completedAt, summary: report.summary || {}, assessment: assessReport(report)
    };
    case "score": return assessReport(report);
    case "issues": return { confirmed: report.issues || [], needsReview: report.incomplete || [], bestPractices: report.bestPractices || [] };
    case "pages": return { pages: report.pages || [] };
    case "graph": return report.graph || { nodes: [], edges: [] };
    case "activity": return { events: report.events || [] };
    case "acr": return { rows: report.acr || [] };
    case "evidence": return evidenceSection(report);
    case "assistive-technology": return {
      metadata: report.assistiveTechnology || null,
      runs: report.assistiveTechnology?.actualRuns || {},
      summary: {
        statesInspected: (report.pages || []).reduce((sum, page) => sum + Number(page.screenReaderStates?.length || 0), 0),
        warnings: (report.pages || []).reduce((sum, page) => sum + (page.screenReaderStates || []).reduce((count, state) => count + Number(state.warnings?.length || 0), 0), 0),
        nvdaStatus: report.assistiveTechnology?.actualRuns?.NVDA?.status || "not-run",
        nvdaAnnouncementsCaptured: Number(report.assistiveTechnology?.actualRuns?.NVDA?.coverage?.announcementsCaptured || 0)
      },
      states: (report.pages || []).flatMap((page) => page.screenReaderStates || [])
    };
    default: return null;
  }
}

function evidenceSection(report) {
  const groups = new Map();
  const withoutEvidence = [];
  for (const issue of [...(report.issues || []), ...(report.incomplete || []), ...(report.bestPractices || [])]) {
    const file = issue.evidence || issue.contextEvidence;
    const finding = {
      id: issue.id,
      ruleId: issue.ruleId,
      pageUrl: issue.pageUrl,
      state: issue.state,
      target: issue.target
    };
    if (!file) {
      withoutEvidence.push(finding);
      continue;
    }
    if (!groups.has(file)) groups.set(file, {
      evidence: file,
      evidenceUrl: evidenceUrl(report.id, file),
      evidenceKind: issue.evidenceKind || (issue.evidence ? "highlighted" : "page-context"),
      issueCount: 0,
      issueIds: [],
      findings: []
    });
    const group = groups.get(file);
    group.issueCount += 1;
    group.issueIds.push(issue.id);
    group.findings.push(finding);
  }
  return {
    uniqueScreenshots: groups.size,
    items: [...groups.values()],
    withoutEvidence
  };
}

function evidenceUrl(reportId, file) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(reportId || "")) ||
      !/^evidence\/(?:baselines\/)?[a-zA-Z0-9._-]+\.(?:png|jpe?g|webp)$/i.test(String(file || ""))) return null;
  return `/reports/${encodeURIComponent(reportId)}/${file}`;
}
