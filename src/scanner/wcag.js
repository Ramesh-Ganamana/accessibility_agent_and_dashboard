// A/AA criterion names and levels verified against https://www.w3.org/TR/WCAG21/
// and https://www.w3.org/TR/WCAG22/. WCAG 2.2 removed criterion 4.1.1.
const definitions = [
  ["1.1.1", "Non-text Content", "A", "2.0", "non-text-content"],
  ["1.2.1", "Audio-only and Video-only (Prerecorded)", "A", "2.0", "audio-only-and-video-only-prerecorded"],
  ["1.2.2", "Captions (Prerecorded)", "A", "2.0", "captions-prerecorded"],
  ["1.2.3", "Audio Description or Media Alternative (Prerecorded)", "A", "2.0", "audio-description-or-media-alternative-prerecorded"],
  ["1.2.4", "Captions (Live)", "AA", "2.0", "captions-live"],
  ["1.2.5", "Audio Description (Prerecorded)", "AA", "2.0", "audio-description-prerecorded"],
  ["1.3.1", "Info and Relationships", "A", "2.0", "info-and-relationships"],
  ["1.3.2", "Meaningful Sequence", "A", "2.0", "meaningful-sequence"],
  ["1.3.3", "Sensory Characteristics", "A", "2.0", "sensory-characteristics"],
  ["1.3.4", "Orientation", "AA", "2.1", "orientation"],
  ["1.3.5", "Identify Input Purpose", "AA", "2.1", "identify-input-purpose"],
  ["1.4.1", "Use of Color", "A", "2.0", "use-of-color"],
  ["1.4.2", "Audio Control", "A", "2.0", "audio-control"],
  ["1.4.3", "Contrast (Minimum)", "AA", "2.0", "contrast-minimum"],
  ["1.4.4", "Resize Text", "AA", "2.0", "resize-text"],
  ["1.4.5", "Images of Text", "AA", "2.0", "images-of-text"],
  ["1.4.10", "Reflow", "AA", "2.1", "reflow"],
  ["1.4.11", "Non-text Contrast", "AA", "2.1", "non-text-contrast"],
  ["1.4.12", "Text Spacing", "AA", "2.1", "text-spacing"],
  ["1.4.13", "Content on Hover or Focus", "AA", "2.1", "content-on-hover-or-focus"],
  ["2.1.1", "Keyboard", "A", "2.0", "keyboard"],
  ["2.1.2", "No Keyboard Trap", "A", "2.0", "no-keyboard-trap"],
  ["2.1.4", "Character Key Shortcuts", "A", "2.1", "character-key-shortcuts"],
  ["2.2.1", "Timing Adjustable", "A", "2.0", "timing-adjustable"],
  ["2.2.2", "Pause, Stop, Hide", "A", "2.0", "pause-stop-hide"],
  ["2.3.1", "Three Flashes or Below Threshold", "A", "2.0", "three-flashes-or-below-threshold"],
  ["2.4.1", "Bypass Blocks", "A", "2.0", "bypass-blocks"],
  ["2.4.2", "Page Titled", "A", "2.0", "page-titled"],
  ["2.4.3", "Focus Order", "A", "2.0", "focus-order"],
  ["2.4.4", "Link Purpose (In Context)", "A", "2.0", "link-purpose-in-context"],
  ["2.4.5", "Multiple Ways", "AA", "2.0", "multiple-ways"],
  ["2.4.6", "Headings and Labels", "AA", "2.0", "headings-and-labels"],
  ["2.4.7", "Focus Visible", "AA", "2.0", "focus-visible"],
  ["2.4.11", "Focus Not Obscured (Minimum)", "AA", "2.2", "focus-not-obscured-minimum"],
  ["2.5.1", "Pointer Gestures", "A", "2.1", "pointer-gestures"],
  ["2.5.2", "Pointer Cancellation", "A", "2.1", "pointer-cancellation"],
  ["2.5.3", "Label in Name", "A", "2.1", "label-in-name"],
  ["2.5.4", "Motion Actuation", "A", "2.1", "motion-actuation"],
  ["2.5.7", "Dragging Movements", "AA", "2.2", "dragging-movements"],
  ["2.5.8", "Target Size (Minimum)", "AA", "2.2", "target-size-minimum"],
  ["3.1.1", "Language of Page", "A", "2.0", "language-of-page"],
  ["3.1.2", "Language of Parts", "AA", "2.0", "language-of-parts"],
  ["3.2.1", "On Focus", "A", "2.0", "on-focus"],
  ["3.2.2", "On Input", "A", "2.0", "on-input"],
  ["3.2.3", "Consistent Navigation", "AA", "2.0", "consistent-navigation"],
  ["3.2.4", "Consistent Identification", "AA", "2.0", "consistent-identification"],
  ["3.2.6", "Consistent Help", "A", "2.2", "consistent-help"],
  ["3.3.1", "Error Identification", "A", "2.0", "error-identification"],
  ["3.3.2", "Labels or Instructions", "A", "2.0", "labels-or-instructions"],
  ["3.3.3", "Error Suggestion", "AA", "2.0", "error-suggestion"],
  ["3.3.4", "Error Prevention (Legal, Financial, Data)", "AA", "2.0", "error-prevention-legal-financial-data"],
  ["3.3.7", "Redundant Entry", "A", "2.2", "redundant-entry"],
  ["3.3.8", "Accessible Authentication (Minimum)", "AA", "2.2", "accessible-authentication-minimum"],
  ["4.1.1", "Parsing", "A", "2.0", "parsing"],
  ["4.1.2", "Name, Role, Value", "A", "2.0", "name-role-value"],
  ["4.1.3", "Status Messages", "AA", "2.1", "status-messages"]
];

export const WCAG_REGISTRY = Object.fromEntries(definitions.map(([id, name, level, since, anchor]) => [id, {
  id, name, level, since, anchor,
  versions: id === "4.1.1" ? ["2.1"] : since === "2.2" ? ["2.2"] : ["2.1", "2.2"],
  description: `Evaluate ${name} across the declared pages, states, and complete processes using the W3C criterion and its exceptions.`,
  sourceUrl: `https://www.w3.org/TR/WCAG${id === "4.1.1" ? "21" : "22"}/#${anchor}`
}]));

const TAG_TO_SC = Object.fromEntries(definitions.map(([id]) => [`wcag${id.replaceAll(".", "")}`, id]));
export const CONFORMANCE_STATUSES = ["Supports", "Partially Supports", "Does Not Support", "Not Applicable"];

export function criteriaForVersion(version = "2.2") {
  if (!["2.1", "2.2"].includes(version)) throw new Error("WCAG version must be 2.1 or 2.2.");
  return Object.values(WCAG_REGISTRY).filter((criterion) => criterion.versions.includes(version));
}

export function criteriaFromTags(tags = []) {
  return [...new Set((Array.isArray(tags) ? tags : []).map((tag) => TAG_TO_SC[tag]).filter(Boolean))];
}

export function isDocumentedReview(review) {
  return Boolean(review && CONFORMANCE_STATUSES.includes(review.status)
    && [review.reviewer, review.notes, review.scope].every((value) => typeof value === "string" && value.trim())
    && Array.isArray(review.evidence) && review.evidence.some((value) => typeof value === "string" && value.trim()));
}

// Severity ranks remediation work. It cannot establish criterion conformance.
export function statusForCriteria(issues = [], review = null) {
  if (!isDocumentedReview(review)) return "Not Evaluated";
  if (issues.length && ["Supports", "Not Applicable"].includes(review.status)) return "Not Evaluated";
  return review.status;
}

export function buildAcrRows(issues = [], incomplete = [], options = {}) {
  const { wcagVersion = "2.2", reviews = [] } = options;
  return criteriaForVersion(wcagVersion).map((criterion) => {
    const matches = issues.filter((issue) => (issue.wcag || criteriaFromTags(issue.tags)).includes(criterion.id));
    const pending = incomplete.filter((issue) => (issue.wcag || criteriaFromTags(issue.tags)).includes(criterion.id));
    const candidate = [...reviews].reverse().find((item) => item.kind === "criterion" && item.targetId === criterion.id);
    const status = statusForCriteria(matches, candidate);
    const review = status === "Not Evaluated" ? null : candidate;
    const selectors = [...new Set(matches.map((issue) => formatTarget(issue.target)).filter(Boolean))];
    const observation = matches.length
      ? `${matches.length} confirmed finding(s). ${[...new Set(matches.map((issue) => issue.help || issue.ruleId).filter(Boolean))].slice(0, 3).join("; ")}. Affected nodes: ${selectors.slice(0, 4).join("; ")}${selectors.length > 4 ? "; …" : ""}.`
      : "No confirmed automated finding mapped to this criterion. This does not establish support.";
    return {
      ...criterion,
      sourceUrl: `https://www.w3.org/TR/WCAG${wcagVersion.replace(".", "")}/#${criterion.anchor}`,
      criterion: `WCAG ${criterion.id} ${criterion.name}`,
      status, issueCount: matches.length, needsReviewCount: pending.length,
      review, reviewStatus: review ? "reviewed" : "needs-review",
      evidence: matches.concat(pending).map((issue) => ({
        findingId: issue.id || null, ruleId: issue.ruleId || null, pageUrl: issue.pageUrl || "", state: issue.state || "default",
        target: formatTarget(issue.target), screenshot: issue.evidence?.screenshot || issue.evidence?.path || (typeof issue.evidence === "string" ? issue.evidence : null),
        findingType: matches.includes(issue) ? "confirmed" : "needs-review"
      })),
      remarks: `${observation} ${pending.length ? `${pending.length} additional finding(s) require human review. ` : ""}${review ? `Reviewer decision by ${review.reviewer}: ${review.notes} Scope: ${review.scope}.` : "Human evaluation is required before assigning a conformance decision."}`
    };
  });
}

export function formatTarget(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) return target.flat(Infinity).join(" → ");
  return "";
}

