const IMPACT_WEIGHT = Object.freeze({ critical: 2.4, serious: 1.3, moderate: 0.55, minor: 0.2 });
const PRINCIPLES = Object.freeze([
  { id: "1", label: "Perceivable" },
  { id: "2", label: "Operable" },
  { id: "3", label: "Understandable" },
  { id: "4", label: "Robust" }
]);

function roundedScore(weight, observedStates) {
  return Math.round(100 * Math.exp(-weight / (Math.max(1, observedStates) * 6))) / 10;
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
  const findings = Array.isArray(report?.issues) ? report.issues : [];
  const pending = Array.isArray(report?.incomplete) ? report.incomplete : [];
  const scannedPages = pages.filter((page) => !page.error).length;
  const failedPages = pages.length - scannedPages;
  const observedStates = Math.max(0, Number(report?.summary?.statesObserved) || report?.graph?.nodes?.length || scannedPages);
  const byImpact = Object.fromEntries(Object.keys(IMPACT_WEIGHT).map((impact) => [impact, 0]));
  for (const finding of findings) {
    const impact = String(finding?.impact || "").toLowerCase();
    if (Object.hasOwn(byImpact, impact)) byImpact[impact] += 1;
  }
  const weightedFindings = Object.entries(byImpact).reduce((sum, [impact, count]) => sum + IMPACT_WEIGHT[impact] * count, 0);
  const available = Boolean(report?.completedAt && scannedPages > 0 && observedStates > 0);
  const score = available ? roundedScore(weightedFindings, observedStates) : null;
  const grade = score == null ? "—" : gradeFor(score);
  const confidence = failedPages || pending.length ? "Limited" : "Coverage-dependent";
  const principles = PRINCIPLES.map(({ id, label }) => {
    const matching = findings.filter((finding) => (finding?.wcag || []).some((criterion) => String(criterion).startsWith(`${id}.`)));
    const weight = matching.reduce((sum, finding) => sum + (IMPACT_WEIGHT[String(finding?.impact || "").toLowerCase()] || 0), 0);
    return { id, label, score: available ? roundedScore(weight, observedStates) : null, confirmedIssues: matching.length };
  });
  return {
    score,
    outOf: 10,
    grade,
    label: "Observed accessibility health",
    status: available ? "provisional" : "unavailable",
    confidence,
    coverage: { scannedPages, attemptedPages: pages.length, failedPages, observedStates },
    counts: { confirmedIssues: findings.length, needsReview: pending.length, byImpact },
    principles,
    methodology: {
      formula: "10 × exp(−weighted confirmed findings ÷ (6 × observed states))",
      severityWeights: IMPACT_WEIGHT,
      gradeThresholds: { "A+": 9.5, A: 8.5, B: 7, C: 5.5, D: 4, F: 0 },
      note: "A heuristic for observed scan results, not a WCAG conformance score. Undetected issues may remain. Review items are not counted as confirmed failures."
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
    case "issues": return { confirmed: report.issues || [], needsReview: report.incomplete || [] };
    case "pages": return { pages: report.pages || [] };
    case "graph": return report.graph || { nodes: [], edges: [] };
    case "activity": return { events: report.events || [] };
    case "acr": return { rows: report.acr || [] };
    case "evidence": return {
      items: [...(report.issues || []), ...(report.incomplete || [])].map((issue) => ({
        id: issue.id, ruleId: issue.ruleId, pageUrl: issue.pageUrl, state: issue.state,
        target: issue.target, evidence: issue.evidence || null,
        evidenceUrl: evidenceUrl(report.id, issue.evidence),
        contextEvidence: issue.contextEvidence || null,
        contextEvidenceUrl: evidenceUrl(report.id, issue.contextEvidence),
        evidenceKind: issue.evidenceKind || null
      }))
    };
    default: return null;
  }
}

function evidenceUrl(reportId, file) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(reportId || "")) ||
      !/^evidence\/(?:baselines\/)?[a-zA-Z0-9._-]+\.(?:png|jpe?g|webp)$/i.test(String(file || ""))) return null;
  return `/reports/${encodeURIComponent(reportId)}/${file}`;
}
