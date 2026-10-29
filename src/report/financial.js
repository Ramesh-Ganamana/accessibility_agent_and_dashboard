import { criteriaForVersion } from "../scanner/wcag.js";

// These are guided test procedures, not automated transactions or a regulatory
// requirements matrix. A reviewer supplies real execution evidence separately.
const step = (id, title, instructions, expected, criteria, requiresSandbox = false) => ({
  id, title, instructions, expected, criteria, requiresSandbox,
  evidenceGuidance: "Reference the test case, URL/state, expected versus observed result, keyboard/speech transcript and redacted screenshots. Record exceptions. Never include customer records, passwords, OTPs, account numbers or access tokens."
});
const journey = (id, title, objective, steps) => ({
  id, title, objective,
  prerequisites: ["Agree the website scope, user role and application build with the owner.", "Use an authorized test account and synthetic data. Do not submit real transactions.", "Record browser/OS and assistive technology versions; exercise success and error paths."],
  steps
});

export const FINANCIAL_JOURNEYS = [
  journey("onboarding", "Onboarding and KYC", "Check that a person can understand and complete the agreed web onboarding flow without relying on sight or a mouse.", [
    step("kyc-instructions", "Understand requirements and accessible alternatives", "Read the registration and KYC instructions using keyboard and a screen reader. Locate eligibility, required documents, help and available alternative verification routes.", "Requirements, instructions and help are discoverable and understandable; essential information is not only visual.", ["1.1.1", "1.3.1", "2.4.6", "3.3.2"]),
    step("kyc-input-errors", "Complete fields and recover from validation errors", "In a sandbox, use synthetic identities to exercise missing/invalid fields and corrections. Check required labels, error summary, field associations and preservation of valid entries.", "Errors identify the affected field and correction; focus and announcements expose the errors without losing valid work.", ["2.1.1", "3.3.1", "3.3.2", "3.3.3", "3.3.7", "4.1.3"], true),
    step("kyc-upload", "Upload and review a sample document", "Use a harmless test document in an approved environment. Test file selection, format/size rejection, progress, replacement and review. Check alternatives to camera-only steps.", "Upload controls and status are keyboard/screen-reader usable; rejection and recovery are explained; alternatives are documented.", ["2.1.1", "3.3.1", "3.3.3", "4.1.2", "4.1.3"], true),
    step("kyc-consent", "Review, correct and submit test onboarding", "Review terms and consent, correct test information, then complete only the approved sandbox flow. Include cancellation and confirmation.", "Consent controls have meaningful names/states; review and correction are available where required; completion is announced and understandable.", ["2.1.1", "3.3.4", "4.1.2", "4.1.3"], true)
  ]),
  journey("authentication", "Login, MFA and session recovery", "Assess accessible authentication and continuity of the agreed financial workflow.", [
    step("auth-login", "Operate login and password tools", "With a test account, check labels, password reveal, password-manager/paste support and any cognitive-function challenge alternatives. Do not record credentials.", "Controls expose correct names and states and can be operated by keyboard; authentication does not impose unsupported cognitive barriers.", ["2.1.1", "3.3.2", "3.3.8", "4.1.2"]),
    step("auth-mfa", "Complete test MFA and recover from an error", "In an approved environment, test an invalid/expired test challenge, resend, alternative method and successful continuation. Never store a challenge or OTP in evidence.", "Challenge instructions, errors, resend status and alternatives are accessible; focus remains meaningful.", ["2.1.1", "2.2.1", "3.3.1", "3.3.3", "3.3.8", "4.1.3"], true),
    step("auth-timeout", "Handle session timeout and restoration", "Trigger a controlled timeout in a sandbox. Inspect warning, extension options, focus, reauthentication and retained work. Document any applicable essential-security exception rather than assuming one.", "Users can perceive and operate time-limit controls where required; reauthentication and lost-work behavior are documented.", ["2.1.1", "2.2.1", "2.4.3", "4.1.3"], true),
    step("auth-recovery", "Recover access without visual-only steps", "Use a test identity to follow the approved account recovery/help path, including errors and return to login.", "Recovery instructions and controls are accessible and alternatives to inaccessible verification steps are identified.", ["2.1.1", "3.3.1", "3.3.2", "3.3.8"], true)
  ]),
  journey("market-data", "Portfolio, market data and charts", "Check access to financial information, including changing prices and complex visual content.", [
    step("market-table", "Read holdings and market tables", "Navigate a representative holdings/watchlist table with a screen reader. Inspect column/row headers, amounts, currency, signs, dates, sorting and pagination. For an Indian platform, include applicable INR/rupee amounts, lakh/crore formatting, instrument symbols/ISINs and masked demat identifiers using synthetic data.", "Values retain their header/context relationships; currency, quantity and gain/loss meaning remain clear; sort controls expose state and updated results are understandable.", ["1.3.1", "1.3.2", "2.1.1", "4.1.2", "4.1.3"]),
    step("market-chart", "Use nonvisual chart information", "Inspect price/performance charts with images disabled and a screen reader. Find meaningful text/data alternatives, units, time range, legends and selection controls.", "Equivalent essential information is available without relying solely on chart shape, location or red/green color.", ["1.1.1", "1.3.1", "1.4.1", "1.4.11"]),
    step("market-live", "Control and understand live updates", "Observe quote/portfolio updates without trading. Check pause/stop controls where applicable and whether announcements overwhelm reading or move focus unexpectedly.", "Required update controls are operable; essential status is exposed without disruptive focus changes. Record what the reader actually says.", ["2.2.2", "3.2.1", "4.1.3"]),
    step("market-responsive", "Read data at zoom and narrow width", "Test 200% text zoom, reflow at 320 CSS-pixel equivalent width and increased text spacing. Inspect values, dialogs and table scrolling; document legitimate two-dimensional exceptions.", "Information and controls remain available without clipping/overlap; exceptions are justified rather than treating all tables as automatically passing.", ["1.4.4", "1.4.10", "1.4.12"])
  ]),
  journey("orders", "Trading and order management", "Validate the approved test order journey without placing or modifying a real order.", [
    step("order-entry", "Enter and validate a sandbox order", "With a non-production trading simulator, select instrument, side, quantity, price and order type. Trigger invalid values and inspect calculated summaries.", "Names, units, relationships and errors are clear to keyboard and screen-reader users; changes do not unexpectedly submit orders.", ["1.3.1", "2.1.1", "3.2.2", "3.3.1", "3.3.2", "4.1.3"], true),
    step("order-review", "Review and correct before commitment", "Inspect sandbox order confirmation, charges and risk information. Change a field or cancel before submitting. Check focus containment and restoration.", "The order can be checked and corrected, or another valid error-prevention mechanism is evidenced; no inaccessible confirmation blocks the journey.", ["2.1.1", "2.1.2", "2.4.3", "3.3.4", "4.1.2"], true),
    step("order-status", "Understand simulated order outcomes", "Complete only an approved simulated order. Inspect accepted, rejected, pending and retry states and duplicate-submission safeguards.", "Outcome and next actions are available without sight; status changes are announced and do not silently repeat a consequential action.", ["3.3.1", "3.3.3", "3.3.4", "4.1.3"], true),
    step("order-amend", "Amend or cancel a simulated order", "In the sandbox, locate an existing test order and follow modification/cancellation including confirmation and a failed attempt.", "The selected order, consequences, review/correction and final status are accessible through the complete process.", ["2.1.1", "3.3.1", "3.3.4", "4.1.3"], true)
  ]),
  journey("payments", "Payments, transfers and withdrawals", "Check financial error prevention and accessible status in a test-money environment.", [
    step("payment-beneficiary", "Select or create a test beneficiary", "In an approved sandbox, select a synthetic recipient or complete test beneficiary setup. Check names, masked identifiers and validation.", "Recipients are distinguishable without visual position; required fields and errors are accessible.", ["1.3.1", "2.1.1", "3.3.1", "3.3.2"], true),
    step("payment-review", "Review amount, recipient and charges", "Enter a test amount/currency and inspect the final summary. Change or cancel before commitment. Check all review controls by keyboard and screen reader.", "Essential transaction details and charges can be checked and corrected, or another valid error-prevention mechanism is demonstrated.", ["2.1.1", "2.4.3", "3.3.4", "4.1.2"], true),
    step("payment-authorize", "Authorize only a simulated transaction", "Use the approved test authorization method and complete a simulated transfer/withdrawal. Exercise rejection, expiry and cancellation without real money.", "Authorization, errors and recovery are accessible, and successful completion has an understandable receipt/status.", ["2.1.1", "3.3.1", "3.3.3", "3.3.8", "4.1.3"], true),
    step("payment-retry", "Recover from pending or failed payment", "Simulate failure/pending states. Inspect retry instructions, return navigation, receipt and duplicate-payment prevention in the sandbox.", "Users can determine whether a payment occurred and what to do next; errors do not lead to accidental duplicate commitment.", ["3.3.1", "3.3.3", "3.3.4", "4.1.3"], true)
  ]),
  journey("documents", "Statements, contract notes and disclosures", "Trace access from website controls through the actual downloaded financial document.", [
    step("document-find", "Find and filter financial documents", "Navigate the document area; choose a date range/type and inspect invalid/empty results with keyboard and a screen reader.", "Filters have labels, errors and result status are exposed, and the chosen document is identifiable.", ["2.1.1", "2.4.4", "3.3.1", "3.3.2", "4.1.3"]),
    step("document-download", "Understand download controls", "Use a synthetic statement/contract note. Check link purpose, format/context, download completion and any alternate accessible representation.", "The user can identify and obtain the intended document without visual-only controls; missing alternatives are recorded.", ["1.1.1", "2.1.1", "2.4.4", "4.1.2"]),
    step("document-content", "Assess the downloaded document separately", "Use document-specific tools and a screen reader on a redacted sample. Inspect tags, reading order, language, headings, financial tables and meaningful alternatives.", "Record an actual document audit or mark blocked; a successful webpage scan must not be treated as a PDF/document pass.", ["1.1.1", "1.3.1", "1.3.2", "3.1.1"]),
    step("document-media", "Review investor guidance and media", "Inspect representative disclosures, instructions and embedded investor/KYC videos. Review caption accuracy, audio-description needs and relevant accessible alternatives with the compliance owner.", "Essential information is available in the needed alternatives; untested media and applicable regulatory requirements are explicitly listed.", ["1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5"])
  ]),
  journey("grievance", "Help, complaints and escalation", "Assess an accessible route for obtaining help and reporting a barrier.", [
    step("help-discovery", "Locate consistent help and accessibility contact", "Find help/contact from representative key pages using landmarks, headings, links and keyboard navigation.", "Help is discoverable and consistently located where required; link purpose and contact instructions are understandable.", ["2.4.4", "2.4.5", "3.2.6"]),
    step("complaint-form", "Submit an approved test complaint", "In an authorized non-production environment, complete a test complaint, attachments, consent and validation. Do not send a real complaint to external staff.", "All fields and errors are accessible; successful submission provides a usable acknowledgement/reference.", ["2.1.1", "3.3.1", "3.3.2", "4.1.3"], true),
    step("complaint-track", "Track and understand a test case", "Use a synthetic case to inspect status, response, escalation and alternative contact routes.", "Case identity, status and next steps are understandable by keyboard/screen reader and not solely color coded.", ["1.4.1", "2.1.1", "4.1.3"]),
    step("help-chat", "Operate support overlays and chat", "Inspect support widgets without sending messages to real staff. Check accessible name, open/close, focus restoration, keyboard trap and transcript/status behavior.", "The widget can be reached and left; controls and relevant messages are exposed without hiding essential help.", ["2.1.1", "2.1.2", "2.4.3", "4.1.2", "4.1.3"])
  ]),
  journey("account", "Account settings and preferences", "Assess consequential account changes and alternative input methods using test data.", [
    step("account-navigation", "Navigate settings and tabs", "Inspect settings tabs/accordions and dialogs. Verify selected/expanded state, focus visibility, dismissal and restoration using keyboard and a screen reader.", "Names, roles, states and navigation order are meaningful; focus is visible and not obscured.", ["2.1.1", "2.1.2", "2.4.3", "2.4.7", "2.4.11", "4.1.2"]),
    step("account-change", "Review and confirm a test account change", "In a sandbox, change synthetic contact or preference data, validate errors, review consequences and cancel or confirm as approved.", "Fields and errors are accessible and applicable error-prevention controls protect consequential changes.", ["3.3.1", "3.3.2", "3.3.3", "3.3.4", "4.1.3"], true),
    step("account-pointer", "Use alternatives to pointer gestures", "Inspect sliders, drag/drop, touch targets and hover/focus content in a narrow viewport. Test keyboard/simple-pointer alternatives and dismissal.", "Required gesture/drag alternatives and target sizing are available; essential hover/focus information remains usable.", ["1.4.13", "2.1.1", "2.5.1", "2.5.2", "2.5.7", "2.5.8"]),
    step("account-language", "Read supported languages and notifications", "Review agreed language variants and financial notifications. Check language metadata, consistent control identification and accessible message content.", "Language and labels are programmatically meaningful; changes do not hide essential financial information or instructions.", ["3.1.1", "3.1.2", "3.2.4", "4.1.3"])
  ])
];

export const FINANCIAL_STATUSES = ["pass", "fail", "blocked", "not-applicable"];
const ENVIRONMENTS = ["sandbox", "staging", "production-read-only"];
export const FINANCIAL_NOTICE = "Guided manual BFSI / Capital Markets website assessment. Procedures and recorded results are not proof of professional experience, verified auditor qualifications, WCAG conformance or SEBI compliance.";
export const FINANCIAL_SAFETY = "This workspace never executes these journeys. Consequential tests require explicit authorization and a sandbox/staging environment with synthetic data. No live orders, transfers, withdrawals, KYC submissions or complaints may be triggered by the crawler.";

export function financialStepById(id) {
  return FINANCIAL_JOURNEYS.flatMap((entry) => entry.steps).find((entry) => entry.id === id);
}

export function validateFinancialExecution(report, input, target) {
  if (!input.execution || typeof input.execution !== "object" || Array.isArray(input.execution)) throw new Error("Financial review execution context is required.");
  const { environment } = input.execution;
  if (!ENVIRONMENTS.includes(environment)) throw new Error("Choose sandbox, staging or production-read-only as the execution environment.");
  if (target.requiresSandbox && ["pass", "fail"].includes(input.status) && environment === "production-read-only") throw new Error("This consequential test requires an authorized sandbox or staging environment; record blocked if unavailable.");
  const execution = { environment };
  for (const [key, label, limit] of [["applicationVersion", "Application build/version", 200], ["browser", "Browser and OS versions", 300], ["assistiveTechnology", "Assistive technology/test method", 300], ["authorizationRef", "Authorization reference", 1000]]) {
    execution[key] = boundedText(input.execution[key], label, limit);
  }
  const findingIds = input.findingIds ?? [];
  if (!Array.isArray(findingIds) || findingIds.length > 100 || findingIds.some((id) => typeof id !== "string" || id.length > 200)) throw new Error("Linked findings must be an array of at most 100 finding IDs.");
  const known = new Set([...(report.issues || []), ...(report.incomplete || [])].map((entry) => entry.id).filter(Boolean));
  if (findingIds.some((id) => !known.has(id))) throw new Error("Linked findings must belong to this report.");
  const confirmed = new Set((report.issues || []).map((entry) => entry.id));
  if (["pass", "not-applicable"].includes(input.status) && findingIds.some((id) => confirmed.has(id))) throw new Error("A passed or not-applicable step cannot link unresolved confirmed findings in this scan. Retest after remediation.");
  return { execution, findingIds: [...new Set(findingIds)] };
}

export function buildFinancialAssessment(report, config) {
  if (config.profile !== "financial") return null;
  const activeCriteria = new Set(criteriaForVersion(config.wcagVersion).map((entry) => entry.id));
  const history = Array.isArray(report.auditReviews) ? report.auditReviews : [];
  const journeys = FINANCIAL_JOURNEYS.map((entry) => ({ ...entry, prerequisites: [...entry.prerequisites], steps: entry.steps.map((target) => {
    // A malformed newest record must not resurrect an older passing decision.
    const latest = [...history].reverse().find((item) => item?.kind === "financial-step" && item.targetId === target.id);
    const review = documentedReview(report, latest, target) ? latest : null;
    return { ...target, criteria: target.criteria.filter((id) => activeCriteria.has(id)), status: review?.status || "not-reviewed", review };
  }) }));
  const steps = journeys.flatMap((entry) => entry.steps);
  const count = (status) => steps.filter((entry) => entry.status === status).length;
  const summary = { journeysTotal: journeys.length, stepsTotal: steps.length, stepsReviewed: steps.filter((entry) => entry.review).length, passed: count("pass"), failed: count("fail"), blocked: count("blocked"), notApplicable: count("not-applicable"), pending: count("not-reviewed") };
  const blockers = [];
  if (summary.pending) blockers.push(`${summary.pending} scenario steps have no valid documented review.`);
  if (summary.failed) blockers.push(`${summary.failed} scenario steps failed and need remediation and retesting.`);
  if (summary.blocked) blockers.push(`${summary.blocked} scenario steps are blocked; their accessibility remains untested.`);
  if (!summary.passed && !summary.pending) blockers.push("No applicable scenario step has a recorded pass; exclusions do not establish financial workflow coverage.");
  const builds = new Set(steps.filter((entry) => entry.review && entry.status !== "not-applicable").map((entry) => entry.review.execution.applicationVersion));
  if (builds.size > 1) blockers.push("Recorded steps span different application builds. Reconcile the scope and retest before making a combined workflow claim.");
  return {
    schemaVersion: 1, mode: "guided-manual", notice: FINANCIAL_NOTICE, safetyNotice: FINANCIAL_SAFETY,
    journeys, summary, readiness: { status: blockers.length ? "incomplete" : "review-recorded", blockers },
    professionalExperience: "not-established",
    completionNotice: "Scenario review progress only. Evidence references and reviewer identities are self-reported, not independently verified. WCAG criterion decisions, complete process validation and regulatory review remain separate."
  };
}

function documentedReview(report, review, target) {
  try {
    if (!review || !FINANCIAL_STATUSES.includes(review.status)) return false;
    for (const [key, limit] of [["reviewer", 200], ["scope", 4000], ["notes", 10000]]) boundedText(review[key], key, limit);
    if (!Array.isArray(review.evidence) || !review.evidence.length || review.evidence.length > 30) return false;
    for (const value of review.evidence) boundedText(value, "Evidence reference", 2000);
    validateFinancialExecution(report, review, target);
    return true;
  } catch { return false; }
}

function boundedText(value, name, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${name} must contain 1 to ${limit} characters of text.`);
  return value.trim();
}
