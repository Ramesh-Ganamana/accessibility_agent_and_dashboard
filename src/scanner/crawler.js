// Stable scanner API. Composition and implementation live in crawl/.
export { runAccessibilityScan } from "./crawl/run.js";
export { scanCurrentState } from "./crawl/checks.js";
export { addReviewFindingsWithEvidence } from "./crawl/findings.js";
export { summarize } from "./crawl/reporting.js";
export { adoptRedirectedOrigin } from "./crawl/navigation.js";
