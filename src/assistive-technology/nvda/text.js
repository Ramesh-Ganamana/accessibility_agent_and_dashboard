

export function unavailable(status, reason, extra = {}) {
  return {
    product: "NVDA",
    actualExecution: false,
    status,
    outcome: "not-executed",
    reason,
    states: [],
    warnings: [reason],
    limitations: ["No NVDA result was inferred from the browser accessibility tree."],
    ...extra
  };
}

export function clean(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function firstLine(value) {
  return String(value || "Unknown error").split(/\r?\n/, 1)[0];
}
