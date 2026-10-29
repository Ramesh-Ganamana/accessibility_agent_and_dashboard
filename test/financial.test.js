import test from "node:test";
import assert from "node:assert/strict";
import { buildAudit, validateAuditReview } from "../src/report/audit.js";
import { FINANCIAL_JOURNEYS, FINANCIAL_STATUSES, buildFinancialAssessment, financialStepById } from "../src/report/financial.js";
import { renderAcrCsv, renderAcrHtml } from "../src/report/export.js";
import { criteriaForVersion } from "../src/scanner/wcag.js";

const configuration = (profile = "financial", wcagVersion = "2.2") => ({ audit: { profile, wcagVersion, level: "AA" } });
const report = (extra = {}) => ({ id: "financial-fixture", targetUrl: "https://finance.example.test", configuration: configuration(), issues: [], incomplete: [], pages: [], auditReviews: [], ...extra });
const execution = (extra = {}) => ({ environment: "sandbox", applicationVersion: "build-42", browser: "Chrome test / Windows test", assistiveTechnology: "NVDA test and keyboard review", authorizationRef: "Approved synthetic-account test plan QA-42", ...extra });
const decision = (extra = {}) => ({ kind: "financial-step", targetId: "market-table", status: "pass", reviewer: "Test reviewer", scope: "Synthetic portfolio; test account; scoped holdings table", notes: "Reviewed header relationships and sort announcements against the expected outcome.", evidence: ["manual/QA-42/holdings-transcript.txt"], execution: execution(), findingIds: [], ...extra });
const steps = (assessment) => assessment.journeys.flatMap((journey) => journey.steps);
const recorded = (source, extra = {}) => validateAuditReview(source, decision(extra));
const allReviewed = (source, status = "pass") => FINANCIAL_JOURNEYS.flatMap((journey) => journey.steps).map((step) => recorded(source, { targetId: step.id, status }));

test("malformed primitive history entries cannot break the audit or claim financial coverage", () => {
  const source = report({ auditReviews: [null, false, "pass", [], { kind: "financial-step", targetId: "market-table", status: "pass" }] });
  const audit = buildAudit(source);
  assert.equal(audit.financial.summary.passed, 0);
  assert.equal(audit.financial.summary.pending, 32);
  assert.ok(audit.criteria.every((row) => row.status === "Not Evaluated"));
});

test("financial catalog has eight distinct journeys and 32 uniquely identified evidence-guided steps", () => {
  assert.equal(FINANCIAL_JOURNEYS.length, 8);
  assert.equal(new Set(FINANCIAL_JOURNEYS.map((journey) => journey.id)).size, 8);
  const catalog = FINANCIAL_JOURNEYS.flatMap((journey) => journey.steps);
  assert.equal(catalog.length, 32);
  assert.equal(new Set(catalog.map((step) => step.id)).size, 32);
  for (const journey of FINANCIAL_JOURNEYS) {
    assert.equal(journey.steps.length, 4);
    assert.ok(journey.title && journey.objective && journey.prerequisites.length);
    for (const step of journey.steps) {
      assert.equal(financialStepById(step.id), step);
      assert.ok(step.title && step.instructions && step.expected && step.evidenceGuidance);
      assert.equal(typeof step.requiresSandbox, "boolean");
      assert.ok(step.criteria.length);
      assert.match(step.evidenceGuidance, /Never include customer records/);
    }
  }
  assert.equal(financialStepById("missing-step"), undefined);
  assert.deepEqual(FINANCIAL_STATUSES, ["pass", "fail", "blocked", "not-applicable"]);
});

test("general reports do not acquire financial scenarios or accept financial-step reviews", () => {
  const source = report({ configuration: configuration("general") });
  assert.equal(buildAudit(source).financial, null);
  assert.equal(buildFinancialAssessment(source, source.configuration.audit), null);
  assert.throws(() => recorded(source), /does not belong/);
  source.auditReviews = [decision()];
  assert.equal(buildAudit(source).financial, null);
  assert.ok(buildAudit(source).criteria.every((row) => row.status === "Not Evaluated"));
});

test("financial criterion mappings follow the selected WCAG version without changing the catalog", () => {
  const original = structuredClone(FINANCIAL_JOURNEYS);
  for (const version of ["2.1", "2.2"]) {
    const audit = buildAudit(report({ configuration: configuration("financial", version) }));
    const allowed = new Set(criteriaForVersion(version).map((criterion) => criterion.id));
    assert.equal(audit.criteria.length, version === "2.1" ? 50 : 55);
    assert.equal(steps(audit.financial).length, 32);
    assert.ok(steps(audit.financial).every((step) => step.criteria.every((id) => allowed.has(id))));
    const login = steps(audit.financial).find((step) => step.id === "auth-login");
    const pointer = steps(audit.financial).find((step) => step.id === "account-pointer");
    assert.equal(login.criteria.includes("3.3.8"), version === "2.2");
    assert.equal(pointer.criteria.includes("2.5.8"), version === "2.2");
  }
  assert.deepEqual(FINANCIAL_JOURNEYS, original);
});

test("an unreviewed financial report states what remains untested and never claims experience", () => {
  const financial = buildAudit(report()).financial;
  assert.deepEqual(financial.summary, { journeysTotal: 8, stepsTotal: 32, stepsReviewed: 0, passed: 0, failed: 0, blocked: 0, notApplicable: 0, pending: 32 });
  assert.equal(financial.mode, "guided-manual");
  assert.equal(financial.readiness.status, "incomplete");
  assert.match(financial.readiness.blockers.join(" "), /32 scenario steps/);
  assert.equal(financial.professionalExperience, "not-established");
  assert.match(financial.notice, /not proof of professional experience/);
  assert.match(financial.safetyNotice, /never executes these journeys/);
  assert.ok(steps(financial).every((step) => step.status === "not-reviewed" && step.review === null));
});

test("financial reviews require documented scope, evidence and complete execution context", () => {
  const source = report();
  const invalid = [
    { execution: undefined }, { execution: null }, { execution: [] },
    { execution: execution({ environment: "production" }) },
    { reviewer: " " }, { scope: "" }, { notes: "" }, { evidence: [] }, { evidence: [""] },
    { status: "Supports" }, { targetId: "missing-step" },
    ...["applicationVersion", "browser", "assistiveTechnology", "authorizationRef"].flatMap((key) => [
      { execution: execution({ [key]: " " }) },
      { execution: execution({ [key]: "invalid\u0000value" }) }
    ]),
    { execution: execution({ applicationVersion: "x".repeat(201) }) },
    { execution: execution({ browser: "x".repeat(301) }) },
    { execution: execution({ assistiveTechnology: "x".repeat(301) }) },
    { execution: execution({ authorizationRef: "x".repeat(1001) }) }
  ];
  for (const changes of invalid) {
    assert.throws(() => recorded(source, changes), (error) => error.status === 400, JSON.stringify(changes));
  }
});

test("financial review validation normalizes input without mutating the original report or request", () => {
  const source = report({ incomplete: [{ id: "uncertain-table", wcag: ["1.3.1"] }] });
  const input = decision({ id: "client-id", at: "client-date", reviewer: " Reviewer ", execution: execution({ applicationVersion: " build-42 " }), findingIds: ["uncertain-table", "uncertain-table"], evidence: ["notes.txt", "notes.txt"] });
  const before = structuredClone({ source, input });
  const accepted = validateAuditReview(source, input);
  assert.deepEqual({ source, input }, before);
  assert.match(accepted.id, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(accepted.at)));
  assert.equal(accepted.reviewer, "Reviewer");
  assert.equal(accepted.execution.applicationVersion, "build-42");
  assert.deepEqual(accepted.findingIds, ["uncertain-table"]);
  assert.deepEqual(accepted.evidence, ["notes.txt"]);
});

test("consequential steps reject production pass/fail while accepting honest blocked or exclusion records", () => {
  const source = report();
  const consequential = FINANCIAL_JOURNEYS.flatMap((journey) => journey.steps).filter((step) => step.requiresSandbox);
  assert.ok(consequential.length > 0);
  for (const target of consequential) {
    for (const status of ["pass", "fail"]) {
      assert.throws(() => recorded(source, { targetId: target.id, status, execution: execution({ environment: "production-read-only" }) }), /consequential test requires/);
      for (const environment of ["sandbox", "staging"]) {
        assert.equal(recorded(source, { targetId: target.id, status, execution: execution({ environment }) }).status, status);
      }
    }
    for (const status of ["blocked", "not-applicable"]) {
      assert.equal(recorded(source, { targetId: target.id, status, execution: execution({ environment: "production-read-only" }) }).status, status);
    }
  }
  assert.equal(recorded(source, { targetId: "market-table", execution: execution({ environment: "production-read-only" }) }).status, "pass");
});

test("linked findings must exist in this report and confirmed failures cannot support a passing step", () => {
  const source = report({ issues: [{ id: "confirmed", wcag: ["1.3.1"] }], incomplete: [{ id: "uncertain", wcag: ["1.3.1"] }] });
  for (const findingIds of [["other-report-finding"], "confirmed", [3], ["x".repeat(201)], Array(101).fill("confirmed")]) {
    assert.throws(() => recorded(source, { findingIds }), (error) => error.status === 400);
  }
  for (const status of ["pass", "not-applicable"]) {
    assert.throws(() => recorded(source, { status, findingIds: ["confirmed"] }), /cannot link unresolved confirmed findings/);
  }
  for (const status of ["fail", "blocked"]) {
    assert.deepEqual(recorded(source, { status, findingIds: ["confirmed", "uncertain"] }).findingIds, ["confirmed", "uncertain"]);
  }
  assert.equal(recorded(source, { findingIds: ["uncertain"] }).status, "pass");
});

test("malformed newest financial history invalidates the step rather than resurrecting an old pass", () => {
  const source = report();
  const previous = recorded(source);
  const malformed = [
    { reviewer: "" }, { scope: "" }, { notes: "" }, { evidence: [] }, { evidence: ["", "notes.txt"] },
    { execution: null }, { execution: execution({ authorizationRef: "" }) },
    { status: "certified" }, { findingIds: ["unknown"] }
  ];
  for (const changes of malformed) {
    source.auditReviews = [previous, { ...previous, ...changes }];
    const step = steps(buildAudit(source).financial).find((entry) => entry.id === previous.targetId);
    assert.equal(step.status, "not-reviewed", JSON.stringify(changes));
    assert.equal(step.review, null);
    assert.equal(buildAudit(source).financial.summary.stepsReviewed, 0);
  }
});

test("stored unsafe or contradictory financial decisions are rejected when rebuilding a report", () => {
  const source = report({ issues: [{ id: "confirmed", wcag: ["1.3.1"] }] });
  source.auditReviews = [decision({ findingIds: ["confirmed"] }), decision({ targetId: "order-entry", execution: execution({ environment: "production-read-only" }) })];
  const financial = buildAudit(source).financial;
  assert.equal(financial.summary.stepsReviewed, 0);
  assert.equal(financial.summary.passed, 0);
  assert.equal(financial.summary.pending, 32);
});

test("financial status counts use latest valid records once and preserve outstanding blockers", () => {
  const source = report();
  source.auditReviews = [
    recorded(source, { targetId: "market-table" }),
    recorded(source, { targetId: "market-table", status: "fail" }),
    recorded(source, { targetId: "market-chart" }),
    recorded(source, { targetId: "order-entry", status: "blocked" }),
    recorded(source, { targetId: "document-media", status: "not-applicable" })
  ];
  const financial = buildAudit(source).financial;
  assert.deepEqual(financial.summary, { journeysTotal: 8, stepsTotal: 32, stepsReviewed: 4, passed: 1, failed: 1, blocked: 1, notApplicable: 1, pending: 28 });
  assert.equal(financial.readiness.status, "incomplete");
  assert.match(financial.readiness.blockers.join(" "), /28 scenario steps.*1 scenario steps failed.*1 scenario steps are blocked/);
});

test("all recorded financial passes do not auto-pass WCAG criteria, manual checks or regulatory assessment", () => {
  const source = report();
  source.auditReviews = allReviewed(source);
  const audit = buildAudit(source);
  assert.equal(audit.financial.summary.passed, 32);
  assert.equal(audit.financial.summary.pending, 0);
  assert.equal(audit.financial.readiness.status, "review-recorded");
  assert.deepEqual(audit.financial.readiness.blockers, []);
  assert.equal(audit.summary.criteriaReviewed, 0);
  assert.equal(audit.summary.checksReviewed, 0);
  assert.ok(audit.criteria.every((row) => row.status === "Not Evaluated"));
  assert.match(audit.financial.completionNotice, /WCAG criterion decisions.*regulatory review remain separate/);
  assert.match(audit.regulatoryNotice, /not a complete SEBI/);
  assert.equal(audit.financial.professionalExperience, "not-established");
});

test("mixed application builds cannot produce combined financial workflow readiness", () => {
  const source = report();
  source.auditReviews = allReviewed(source);
  source.auditReviews.push(recorded(source, { execution: execution({ applicationVersion: "build-43" }) }));
  const financial = buildAudit(source).financial;
  assert.equal(financial.summary.passed, 32);
  assert.equal(financial.readiness.status, "incomplete");
  assert.match(financial.readiness.blockers.join(" "), /different application builds/);
});

test("all not-applicable decisions cannot masquerade as tested financial workflow coverage", () => {
  const source = report();
  source.auditReviews = allReviewed(source, "not-applicable");
  const financial = buildAudit(source).financial;
  assert.equal(financial.summary.stepsReviewed, 32);
  assert.equal(financial.summary.notApplicable, 32);
  assert.equal(financial.summary.pending, 0);
  assert.equal(financial.readiness.status, "incomplete");
  assert.match(financial.readiness.blockers.join(" "), /No applicable scenario step has a recorded pass/);
  source.auditReviews.push(recorded(source, { execution: execution({ applicationVersion: "build-43" }) }));
  assert.equal(buildAudit(source).financial.readiness.status, "review-recorded");
  assert.equal(buildAudit(source).financial.summary.passed, 1);
});

test("financial HTML and CSV exports include scenario execution evidence without script or formula injection", () => {
  const source = report({ issues: [{ id: "confirmed", wcag: ["1.3.1"] }] });
  source.auditReviews = [recorded(source, {
    status: "fail", findingIds: ["confirmed"],
    reviewer: '=HYPERLINK("https://example.test")',
    notes: '<img src=x onerror="alert(1)"> financial scenario notes',
    scope: "+SUM(1,2)", evidence: ["@financial-evidence"],
    execution: execution({ applicationVersion: "<script>bad()</script>", authorizationRef: "<b>QA-42</b>" })
  })];
  const html = renderAcrHtml(source);
  const csv = renderAcrCsv(source);
  for (const content of [html, csv]) {
    assert.match(content, /Read holdings and market tables/);
    assert.match(content, /financial scenario notes/);
    assert.match(content, /NVDA test and keyboard review/);
    assert.match(content, /QA-42/);
    assert.match(content, /confirmed/);
    assert.match(content, /not proof of professional experience/);
  }
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<script>bad()</script>"));
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes("'+SUM"));
  assert.ok(csv.includes("'@financial-evidence"));
  assert.match(csv, /market-table/);
});
