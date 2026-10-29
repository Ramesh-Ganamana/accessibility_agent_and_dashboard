# Accessibility Agent Progress and Future Plan

Management review | 28 October 2026 | Website testing scope

## Current position

We have implemented a local agent for general and financial websites. It discovers pages and interaction states, runs automated checks, captures evidence, and supports human audit decisions. NVDA integration, report comparison, remediation tracking, and draft conformance reporting are included.

Automated verification passed. The next priority is a controlled pilot with fresh live NVDA verification and application-specific journeys. Complete WCAG conformance, a completed SEBI assessment, and reliability across all websites/readers are not established.

## What this gives the team

- Testers and developers get repeatable checks, affected controls, evidence, and fix tracking.
- Reviewers get scoped findings and a documented decision process.
- Managers get coverage, unresolved work, and comparable-scan results.

Fixing the findings can benefit blind screen-reader users, keyboard users, and people with other access needs. Evaluation with assistive-technology users remains necessary.

## Latest verification

| Check | Result | What the result establishes |
| --- | --- | --- |
| Unit and API suite | 245 passed | Tested logic, contracts, safety rules, report handling, and simulated NVDA lifecycle behavior |
| Headless browser fixtures | 38 passed | Local browser workflows including login, exclusions, states, tabs, reports, journeys, and exports |
| NVDA add-on tests | 81 passed | Add-on logic under simulated reader and operating-system events |
| Syntax checks | 181 files passed | 170 JavaScript, 9 PowerShell, and 2 Python files parsed successfully |
| Installed dependencies | Check passed | Required project packages were present |

Verification date: 28 October 2026. Sandbox-restricted checks passed when rerun outside that environment. Browser tests used local samples, not customer sites or paid AI calls.

Live NVDA speech was not rerun. Detected configuration does not prove speech or task usability. These results do not establish production readiness or compliance sign-off.

<!-- pagebreak -->

## Delivered website scanning capabilities

The same web scanner serves general and financial profiles. The financial profile adds specialist review material; it does not turn ordinary crawling into an automated financial audit.

| Area | Implemented capability | Practical purpose and boundary |
| --- | --- | --- |
| Pages and states | Separate page, state, and depth limits; interaction exploration; recorded crawl graph | Covers reachable menus, dialogs, tabs, and routes. A single page can contain several states. Limits and failed restoration leave explicit coverage gaps. |
| Application surfaces | Chromium scanning of documents, first-party frames, and open Shadow DOM; responsive mobile emulation | Finds defects beyond a flat page. Closed shadow roots, excluded frames, unvisited routes, and real-device behavior remain gaps. |
| Login and sessions | Automatic login-control discovery, username-first flows, optional selector overrides, context selection, saved sessions | Reaches authorized protected screens. MFA, CAPTCHA, passkeys, and security approval are not bypassed. |
| Excluded actions | Multiple Do not click entries using names, words, image metadata, attributes, selectors, and URLs | Applies exclusions to relevant discovery and activation paths. It does not stop a site's own background activity or guarantee that arbitrary controls are harmless. |
| Blockers and new tabs | Bounded obstruction handling, application-created child-tab inspection, and return to the original tab/state where possible | Helps traversal continue without treating unrelated user tabs as test scope. Failed recovery is reported rather than disguised as coverage. |
| Automated checks | axe rules plus keyboard/focus, layout adaptation, text spacing, media, and basic document checks | Produces observed defects and review candidates. Semantics, readability, media quality, and complete processes still need human evaluation. |
| Optional AI | Image-description review and guarded fallback for stalled navigation; separate login assistance | Helps selected uncertain cases. It requires configured access and can incur cost; permitted screenshots and sanitized metadata may leave the machine. |

## Controls and evidence delivered

The dashboard now brings New scan to the top and provides dedicated areas for overview, findings, the crawl graph, screen-reader results, conformance review, remediation, and comparison. The user guide explains every dashboard option, its purpose, examples, defaults, and limitations.

Findings include rule and criterion mappings, an affected control, observed state, and available screenshot evidence. Confirmed findings, uncertain cases, and best-practice recommendations are separated. Context-only images and missing captures are identified rather than treated as proof of a defect or pass.

Progress and checkpoints retain partial work when a scan stops. A completed bounded crawl means the requested run ended; it does not mean the whole application was reached or passed.

<!-- pagebreak -->

## NVDA integration and engineering structure

### What NVDA adds

The browser accessibility tree describes information exposed by Chromium. NVDA adds evidence of what an actual screen reader announces during controlled keyboard operations. Keeping those sources separate prevents an approximate tree preview from being presented as a real reader test.

The default implementation prepares NVDA with the visible browser, scans the current state, performs its NVDA checks, and then continues crawling. This reduces the need to reconstruct a state later. Explicit after-crawl replay remains an alternative, with unreproducible states reported as untested.

The implemented checks include:

- Focus navigation with captured speech and available focused-control metadata.
- Read-to-end attempts for available browse content, with a timeout and completion evidence.
- Bounded heading and table navigation samples.
- Required-field observations using native/ARIA semantics, labels, and supported associated asterisk instructions.
- State/action screenshots, warnings, execution counts, partial results, and timing diagnostics.

Speech is paced with completion waits and a listener-oriented default rate. Captured speech is not a verified pronunciation assessment. Required-field checks do not add missing semantics to the website or invent an announcement.

### Current operating constraint

The integration requires an interactive Windows desktop and the correct test browser/tab in the foreground. Ownership and focus checks constrain commands and captured evidence. Focus departures can trigger a pause, recovery, or interruption; closing the owned test scope triggers cleanup.

NVDA is not an independent background-tab worker. We cannot promise uninterrupted testing while someone actively uses another application on the same desktop. Zero startup latency, all-language reading, all controls being reached, and complete form or business-journey testing are not established.

### Architecture and maintainability

We separated the dashboard, API routes, crawler, and NVDA implementation into focused modules. Queue management, interaction exploration, evidence, reporting, native keyboard commands, speech capture, and focus recovery have distinct responsibilities. Compatibility entry points and the existing npm start workflow were retained.

Architecture tests check import boundaries and dependency cycles. The contributor guide identifies the module to change and the focused regression command. This improves handover without adding a new application framework or deployment requirement.

### Local safety and privacy measures

The dashboard uses local request guards. Saved Windows sessions are protected with user-scoped encryption outside the repository. Credential payloads are kept out of intended AI inputs, and reports sanitize authentication values. Screenshots, transcripts, and saved sessions can still contain sensitive information and need access and retention controls.

<!-- pagebreak -->

## Reporting and financial assessment support

### What is available now

| Capability | Delivered behavior | What remains a human responsibility |
| --- | --- | --- |
| WCAG review matrix | WCAG 2.1 and 2.2 A and AA registries, with 50 and 55 criteria respectively | Decide conformance across the agreed scope. A criterion appearing in the registry does not mean it was fully tested. |
| Human review records | Reviewer, decision, scope, rationale, evidence references, and retained history | Perform the tests and substantiate each decision. Entered identity and evidence are not independently authenticated. |
| VPAT and ACR material | JSON/CSV/HTML reports plus VPAT 2.5-structured HTML and Word exports in supported editions | Complete and approve the conformance assessment and required reporting format. These are not automatic certificates or the official ITI template file. |
| Regulatory review | Built-in GIGW and SEBI checklist material plus import of authorized checklist content | Verify current requirements, applicability, wording, licensing, and evidence. Selecting a profile/checklist does not establish regulatory approval. |
| Financial workbook | 32 guided review steps across eight financial website journeys | Execute approved scenarios, including failures and recovery. The workbook records evidence; it does not place trades or make payments. |
| Scripted journeys | Authored step sequences, declared origins/environments, checkpoints, and consequential-action safeguards | Supply application-specific scripts, synthetic data, authorization, and meaningful assertions. Generic crawling is not a substitute. |
| Remediation and comparison | Owners, status, due dates, notes, repeated findings, and comparable-scan deltas | Fix the audited application and verify the result. An absent finding is not automatically a verified fix. |

### Financial journey coverage

The workbook covers onboarding and KYC, authentication, portfolio and market data, trading and orders, payments and withdrawals, statements and disclosures, help and complaints, and account settings. These are guided assessment areas, not evidence that all eight journeys have been tested in a client platform.

A financial pilot needs approved sandbox/staging workflows, synthetic identities and documents, and simulated transactions where appropriate. Production observation must remain within its authorization. The tool cannot create genuine BFSI engagement experience, client references, professional qualifications, or regulatory sign-off.

### How to use the current reports

Use automated findings to prioritize work, then review uncertain observations and untested criteria. Record decisions with actual scope and evidence. After a repair, scan the changed build and repeat the affected user task before closing the issue. Preserve original observations so the audit trail distinguishes a finding, a claimed fix, and a verified retest.

<!-- pagebreak -->

## Remaining gaps

The following gaps limit what we can promise today. They apply to ordinary websites as well as financial applications, with additional domain and regulatory obligations for the latter.

| Gap | Why it matters | Evidence needed to close it |
| --- | --- | --- |
| Fresh real NVDA verification | The latest passing checks simulate reader behavior; desktop focus and speech can still fail in the installed environment. | Repeatable live runs with transcripts, audio-completion observations, screenshots, multi-state coverage, and owned-process cleanup. |
| Complete user tasks | Reachable controls and sampled navigation do not cover every success, failure, cancellation, or recovery path. | Approved journey scripts and experienced human testing of the actual application and roles. |
| Other reader and browser combinations | JAWS, VoiceOver, and TalkBack execution has not been established by the NVDA adapter. | Product-specific test environments, execution adapters or manual protocols, and separate evidence. |
| Languages and media quality | English-oriented speech checks and automated media/document heuristics cannot verify every language, caption, description, or reading order. | Language-specific voices and test content, human listening, full document/media assessment, and recorded limitations. |
| Full conformance and regulatory assessment | Automated coverage and a completed checklist are not an expert opinion or approval. | Qualified review of every applicable criterion/process and compliance-owner validation of current requirements. |
| Shared hosted service readiness | The current local dashboard and desktop runner are not a proven secure multi-user hosted platform. | A reviewed architecture, isolation, authentication, authorization, secrets management, retention, monitoring, and operational tests. |

## Immediate pilot recommendation

Approve a small English-language pilot on one general web application and one financial sandbox, with representative test accounts and agreed journeys. Keep the pilot on a dedicated Windows desktop until live-reader stability and evidence quality are demonstrated.

Record observed coverage, blocked states, speech completion, recovery behavior, manual-review findings, and repeatability across agreed consecutive runs. Do not set a universal coverage percentage from the number of pages or states discovered.

Before the pilot, agree measurable acceptance thresholds and the people who can accept residual gaps. Development and QA should own technical verification; an accessibility reviewer should assess usability and criterion decisions; the domain/compliance owner should validate financial scope. These are proposed responsibilities, not confirmed staffing commitments.

<!-- pagebreak -->

## Proposed future phases

These phases are proposals for prioritization. They are not completed features, approved budgets, or delivery commitments. Dates and estimates should follow scope agreement and the pilot results.

### Phase 1 Prove reliability in the target environment

First, run the live two-state Chrome/NVDA regression and representative application journeys. Validate startup, clear English speech, reading completion, dialog and child-tab handling, focus recovery, required-field observations, screenshots, and cleanup. Improve diagnostics for failures that the pilot demonstrates.

Add explicit user-visible cancellation and lifecycle feedback to the dashboard. Preserve partial evidence, avoid duplicate jobs, and provide a clear indication of whether a scan or owned reader is still running.

Acceptance: repeated approved runs complete the expected states/checks, preserve truthful partial outcomes on interruption, and leave no owned reader or test browser running after cleanup. Agree the repeat count and performance thresholds before testing.

### Phase 2 Establish complete task and audit coverage

Build application-specific journey suites for ordinary and financial workflows, including error, timeout, cancellation, and recovery paths. Extend assertions beyond a screen being reached. Combine automation with keyboard-only and experienced screen-reader review, including users with disabilities where appropriate.

Complete criterion decisions and financial evidence records only for tested scope. Retest fixes and validate comparison/backlog conclusions. Strengthen document/media review beyond structural flags.

Acceptance: every agreed priority journey has a repeatable procedure, test data, expected outcome, evidence, and reviewed disposition; remaining criteria and excluded paths are explicitly listed.

### Phase 3 Broaden supported environments

Prioritize additional desktop/browser combinations and JAWS, VoiceOver, and TalkBack website testing according to user needs. Establish product-specific execution or human-test protocols. Add multilingual test cases and human listening checks rather than assuming an installed voice guarantees correct language switching.

Acceptance: publish a supported combination matrix with versions, proven behaviors, known limits, and separate results for each reader. No product is marked executed without its own evidence.

### Phase 4 Evaluate secure hosted operation

Design an Azure proof of concept with a separate coordinator and isolated test workers. Validate the current NVDA adapter on a dedicated interactive Windows worker before selecting the deployment model. Do not assume a headless process or ordinary container preserves desktop focus and speech behavior.

Evaluate access control, job isolation, concurrency, secrets, evidence storage/redaction, retention, recovery, and monitoring. Obtain current infrastructure, product-licensing, and AI-usage estimates before funding approval. No deployment has been performed as part of this plan.

Acceptance: security and operations reviews approve the design, and an authorized pilot demonstrates session isolation, reliable desktop execution, cleanup, cost visibility, and recoverable failures.

<!-- pagebreak -->

## Decisions and resources for management

### Approve the next bounded step

Approve reliability verification and a controlled pilot. Confirm the two applications, browser/reader combination, test roles, journeys, and acceptance thresholds before expanding scope.

| Decision or resource | Proposed responsibility | Required outcome |
| --- | --- | --- |
| Pilot scope and acceptance | Product owner and QA lead | Written scope, priority journeys, versions, exclusions, and acceptance criteria |
| Dedicated test desktop | Engineering and IT | Approved Windows environment, installed reader/profile, and an uninterrupted test session |
| Test accounts and data | Application owner and security | Authorized accounts, synthetic records, controlled evidence, and safe sandbox workflows |
| Human accessibility review | Accessibility lead or qualified reviewer | Task-based assessment and evidence-backed conformance decisions |
| Financial applicability | Domain and compliance owners | Current applicable requirements and authorized financial assessment scope |
| Hosting and procurement | IT, security, and finance | Reviewed proof-of-concept design and current quotes before any purchase/deployment |

### Measures to track during the pilot

- Completed task checkpoints and NVDA checks, with blocked or incomplete work separated.
- Repeatability, startup/task duration, interruptions, recovery, and resource/AI usage.
- Human-confirmed findings, false positives, missed defects, and evidence quality.
- Verified fixes, regressions, and unresolved risks.

### Evidence and maintenance references

Repository references: docs/dashboard-user-guide.md for controls; docs/architecture.md for module ownership; docs/financial-assessment-guide.md for financial assessment; README.md and package.json for capabilities and commands.

Latest verification commands: node --test --test-reporter=spec; npm run test:browser; npm run test:nvda-addon. Syntax and dependency checks were run separately.

Next native check: npm run test:nvda-live-crawl-browser. It takes desktop focus and speaks, so use an approved free desktop session. A local pass still requires application-specific and human task verification.
