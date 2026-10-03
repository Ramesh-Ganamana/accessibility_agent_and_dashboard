export const WCAG_REGISTRY = {
  "1.1.1": {
    id: "1.1.1",
    name: "Non-text Content",
    level: "A",
    description: "Text alternatives are provided for meaningful non-text content."
  },
  "1.3.1": {
    id: "1.3.1",
    name: "Info and Relationships",
    level: "A",
    description: "Structure and relationships are programmatically determinable."
  },
  "1.4.3": {
    id: "1.4.3",
    name: "Contrast (Minimum)",
    level: "AA",
    description: "Text has sufficient foreground/background contrast."
  },
  "2.1.1": {
    id: "2.1.1",
    name: "Keyboard",
    level: "A",
    description: "All functionality is operable through a keyboard interface."
  },
  "2.4.3": {
    id: "2.4.3",
    name: "Focus Order",
    level: "A",
    description: "Focusable components receive focus in a meaningful order."
  },
  "2.4.7": {
    id: "2.4.7",
    name: "Focus Visible",
    level: "AA",
    description: "Keyboard focus is visibly indicated."
  },
  "4.1.2": {
    id: "4.1.2",
    name: "Name, Role, Value",
    level: "A",
    description: "User interface components expose accessible name, role, and state."
  }
};

const TAG_TO_SC = {
  wcag111: "1.1.1",
  wcag131: "1.3.1",
  wcag143: "1.4.3",
  wcag211: "2.1.1",
  wcag243: "2.4.3",
  wcag247: "2.4.7",
  wcag412: "4.1.2"
};

export function criteriaFromTags(tags = []) {
  return [...new Set(tags.map((tag) => TAG_TO_SC[tag]).filter(Boolean))];
}

export function statusForCriteria(issues) {
  if (!issues.length) return "Supports";
  if (issues.some((issue) => issue.impact === "critical" || issue.impact === "serious")) {
    return "Does Not Support";
  }
  return "Partially Supports";
}

export function buildAcrRows(issues) {
  return Object.values(WCAG_REGISTRY).map((criterion) => {
    const matches = issues.filter((issue) => issue.wcag?.includes(criterion.id));
    const selectors = [...new Set(matches.map((issue) => formatTarget(issue.target)).filter(Boolean))];
    return {
      criterion: `WCAG ${criterion.id} ${criterion.name}`,
      level: criterion.level,
      status: statusForCriteria(matches),
      issueCount: matches.length,
      remarks: matches.length
        ? `${matches.length} finding(s). ${summarizeRules(matches)} Affected nodes: ${selectors.slice(0, 4).join("; ")}${selectors.length > 4 ? "; …" : ""}`
        : `No automated failures were detected for ${criterion.name}. Manual review may still be required.`
    };
  });
}

function summarizeRules(issues) {
  const rules = [...new Set(issues.map((issue) => issue.help))];
  return `${rules.slice(0, 3).join("; ")}.`;
}

export function formatTarget(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) return target.flat(Infinity).join(" → ");
  return "";
}

