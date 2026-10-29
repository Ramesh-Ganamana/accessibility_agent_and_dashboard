# Financial website assessment operating guide

## What is implemented

The shared crawler, axe checks, evidence capture and optional live NVDA adapter support both general and financial website profiles. The financial profile adds a guided evidence workbook with 32 test steps across eight journeys. This is reusable audit tooling, not proof of BFSI client experience, auditor qualifications or completed regulatory compliance.

The workbook records human execution. It does not drive these workflows, submit forms, place orders, transfer money or send complaints. Existing crawler exclusions are heuristics, not a guarantee that arbitrary websites are read-only. Run financial scans in an approved test environment.

| Journey | What the workbook asks a reviewer to exercise |
| --- | --- |
| Onboarding and KYC | Instructions and alternatives, field errors, synthetic document upload, consent and correction |
| Authentication | Login/password tools, test MFA, controlled timeout and account recovery |
| Portfolio and market data | Table relationships, chart alternatives, live updates, zoom/reflow |
| Trading and orders | Sandbox entry/errors, review/correction, simulated outcomes, amendment/cancellation |
| Payments and withdrawals | Test beneficiary, review of amount/currency/charges, simulated authorization, failure/retry |
| Statements and disclosures | Find/download documents, separately audit document contents, review investor media |
| Help and complaints | Discover help, sandbox complaint, test case tracking, support widget operation |
| Account settings | Tabs/dialogs, sandbox changes, gesture alternatives, language and notifications |

## Carry out an assessment

1. **Agree the scope and authority.** Record the organization, product/build, user roles, website URLs, complete processes, browsers, assistive technology combinations, exclusions and acceptance method in an approved test plan. Have the compliance owner determine applicable regulators and standards. Not all BFSI organizations are governed by SEBI for every activity.
2. **Prepare safe test conditions.** Obtain a sandbox or staging environment, synthetic identities/documents, test funds and a simulated trading setup as appropriate. Document who authorized testing. Keep real credentials, OTPs, customer records and financial identifiers out of evidence. “Staging” alone is not authorization to transact.
3. **Scan using the financial profile.** Select WCAG 2.1 or 2.2 A + AA as agreed. If NVDA is enabled, use the required interactive Windows desktop. Check crawl coverage and blocked/skipped states; an unvisited process remains untested.
4. **Execute the guided steps manually.** Open the financial workbook in VPAT / ACR. Read prerequisites and expected outcomes; test the agreed success, failure, cancellation and recovery paths. Use keyboard-only and screen-reader methods as appropriate. The recorded NVDA samples assist review but do not replace complete process testing.
5. **Record actual outcomes.** Use Record scenario review. Supply the tested build, browser/OS, reader/method, environment, authorization reference, scope, reviewer name, rationale and controlled evidence references. Mark unavailable tests `blocked`, not `pass`. For blocked tests, explicitly record `not run` / `unknown` where applicable and reference the pending authorization request or restriction; do not invent an approval or tested environment. Explain every `not-applicable` decision. Evidence references and identities are self-reported; the tool does not verify their authenticity or content.
6. **Link findings and remediate.** Link relevant IDs from the same scan; use the organization's issue tracker for owners, priorities, fixes and build references. A linked unresolved confirmed finding prevents a contradictory pass/exclusion. The audited website is not automatically repaired by this tool.
7. **Retest the actual fix.** Run a new scan of the changed build and repeat the affected complete process, including regressions. Attach the new evidence and cross-reference the original finding in your tracker. Absence from a later crawl alone is not verified closure. Original scans and review history remain intact.
8. **Complete professional review and reporting.** Assess every applicable criterion in the agreed scope, not just the workbook steps. Finalize WCAG decisions with evidence; conduct the applicable regulatory assessment and use the appropriate official reporting format. JSON/CSV/HTML exports are working material, not an official completed ITI VPAT or a compliance certificate.

## Interpreting the workbook

- `not-reviewed`: no valid documented result for this step.
- `blocked`: constraints prevented testing; accessibility has not been established.
- `fail`: the reviewer recorded a failed outcome requiring remediation/retest.
- `pass`: a reviewer recorded a scoped passing outcome; it is not an automated or independently verified pass.
- `not-applicable`: documented exclusion, not successful execution.

“Scenario reviews recorded” only describes workbook progress. Pending/failed/blocked steps, inconsistent application builds, and an entirely excluded workbook remain gaps. A completed workbook does not establish that all relevant financial processes were covered. Each application may require additional domain-specific tests. Scenario reviews never automatically set WCAG conformance or professional-experience status.

## Evidence needed for a genuine BFSI track record

These must come from real work, not generated claims:

- An authorized financial-website engagement with a documented scope and tested build.
- Named accessibility professionals with independently checked, applicable qualifications and relevant responsibilities.
- Actual test execution records, observed barriers, sanitized evidence and meaningful coverage of complete financial journeys.
- Developer remediation records plus independent or appropriately qualified verification required by the engagement.
- A reviewed final report, client/owner acceptance and permission to use any case study or reference.
- A current, entity-specific regulatory requirements assessment approved by the compliance owner.

The code cannot create employment experience, credentials, client endorsements, auditor appointment or legal approval. Until those exist, describe the product as a **financial-website accessibility audit-assistance platform**.

## APIs and validation

- `GET /api/reports/:id/financial` returns the workbook or `null` for a general report.
- `POST /api/reports/:id/reviews` accepts `kind: "financial-step"`, a workbook step ID as `targetId`, a supported status, and the normal reviewer/scope/notes/evidence fields.
- Financial reviews additionally require `execution.environment` (`sandbox`, `staging`, `production-read-only`), `applicationVersion`, `browser`, `assistiveTechnology` and `authorizationRef`.
- `findingIds` is optional and can only reference findings in this report. No automated transaction endpoint is provided.
- The normal JSON/CSV/HTML export endpoints include the current workbook and execution context. Old scan JSON is not overwritten by a review.

## Reference boundaries

The procedures above are domain test guidance, not a complete legal checklist. Review current official sources with the responsible compliance owner:

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [WCAG 2.1](https://www.w3.org/TR/WCAG21/).
- [W3C evaluation guidance](https://www.w3.org/WAI/test-evaluate/) — tools alone do not establish conformance.
- [ITI VPAT / ACR guidance](https://www.itic.org/policy/accessibility/vpat).
- [SEBI digital accessibility framework](https://www.sebi.gov.in/sebi_data/attachdocs/aug-2025/1754651443956.pdf), with applicable amendments and clarifications; do not infer current deadlines from the original circular alone.
