# Architecture and contributor guide

## What changed

The API, dashboard, crawler, and NVDA implementation have been split into focused ES modules. The existing Express, Playwright, axe-core, and native NVDA integration remain in place. No new runtime dependency, frontend build tool, or installation is required. The HTTP endpoints, report files, form IDs, settings, and `npm start` command remain compatible.

This is a behavior-preserving modularization, not a new accessibility engine. The crawler and NVDA public entry points retain compatibility exports. Native command order, speech waits, state limits, exclusions, ownership checks, and recovery policies are retained. Some coordinators remain several hundred lines because they describe one ordered lifecycle; splitting them into arbitrary tiny files would not make that lifecycle clearer.

## Read the system in this order

1. [`src/server.js`](../src/server.js): starts the local listener only when executed directly. Importing it does not start a service, scan, browser, or NVDA.
2. [`src/api/app.js`](../src/api/app.js): creates an Express app, wires security and feature routers, and creates an isolated job map per app instance. Tests can inject scan/journey runners and NVDA capability detection.
3. [`src/api/routes/scans.js`](../src/api/routes/scans.js): validates the request, combines Do not click entries, constructs scan configuration, starts an explicitly requested scan, and exposes job status.
4. [`src/scanner/crawler.js`](../src/scanner/crawler.js): public scanner interface; [`crawl/run.js`](../src/scanner/crawl/run.js) composes queue, page/state checks, report finalization, and optional NVDA tests.
5. [`src/report/`](../src/report/): persists evidence and assembles assessment, review, comparison, remediation, and export models.
6. [`public/app.js`](../public/app.js): wires the dashboard. Feature modules render the report and invoke explicit user actions.

```text
Dashboard scan form -> scan API -> crawler -> observed state
                                          -> automated checks + evidence
                                          -> optional live NVDA test
                                          -> next state (within limits)
                                          -> saved report
Dashboard polling <- job lifecycle events <- scan runner
Dashboard views   <- report/review APIs    <- saved evidence + reviewer decisions
```

## Where to make a change

| Task | Primary code | Focused regression command |
| --- | --- | --- |
| Dashboard layout and colors | `public/index.html`, `styles.css`, `dashboard.css` | `npm run test:dashboard-refresh` |
| Scan form, progress, journey controls | `public/features/scan.js` | `npm run test:live-status` |
| Capability and Do not click field feedback | `public/features/capabilities.js` | `npm run test:live-status` |
| Actual Do not click protection | `src/browser/action-exclusions.js`, scanner action guards | `npm run test:action-exclusions` |
| Crawl queue, replay paths and discovered tabs | `src/scanner/crawl/queue.js` | `npm run test:crawl-limits`, `test:tab-switching` |
| Page scans and interaction-state traversal | `src/scanner/crawl/page.js`, `interactions.js` | `npm run test:interaction-crawl` |
| Findings and evidence panel | `public/features/findings.js` | `npm run test:report-tabs` |
| Crawl graph | `public/features/graph.js` | `npm run test:report-tabs` |
| NVDA result display | `public/features/assistive-technology.js` | `npm run test:live-status` |
| NVDA lifecycle and tab ownership | `src/assistive-technology/nvda-live.js` | `node --test test/nvda-live.test.js` (mock reader) |
| NVDA per-state commands and partial evidence | `src/assistive-technology/nvda/live-state-runner.js` | `npm run test:live-nvda-crawl` (mock reader) |
| Native focus recovery and background tab watch | `src/assistive-technology/nvda/scope-recovery.js`, `tab-scope-watch.js` | `npm run test:architecture`, `node --test test/nvda-live.test.js` |
| Required-field/asterisk evidence | `src/assistive-technology/required-fields.js` | `npm run test:required-fields` |
| Audit, financial review, compliance, VPAT UI | `public/features/audit.js` | `npm run test:audit-workflow`, `test:financial-workflow`, `test:compliance`, `test:vpat` |
| Report comparison | `public/features/comparison.js`, `src/report/comparison.js` | `npm run test:report-comparison` |
| Remediation backlog | `public/features/remediation.js`, `src/api/routes/backlog.js`, `src/report/backlog.js` | `npm run test:remediation` |
| Request validation and scan startup | `src/scan-request.js`, `src/api/routes/scans.js` | `npm run test:architecture` |
| Job progress/stopped/error status | `src/api/jobs/lifecycle.js` | `node --test test/review-fixes.test.js` |
| Login and session handling | `src/browser/session.js`, `session-store.js` | `npm run test:auth`, `test:auth-auto` |

## Module rules

- Keep `public/app.js` as the composition point. Feature modules must not import it or attach top-level event handlers. Bind user actions in the entry point; put rendering and feature behavior in the relevant module.
- Cross-feature dependencies are explicit imports. When a feature needs a coordinator action, inject a named callback, as in `createScanController` and `createGraphView`; do not import the entry point back into the feature.
- `public/state.js` owns dashboard selection and request counters. It does not hold login credentials. `public/shared/ui.js` contains reusable DOM, formatting, and fetch helpers, not business rules.
- Route modules use `express.Router()` factories. They validate/translate HTTP requests and delegate to the existing domain modules. Do not duplicate accessibility, scoring, or conformance logic in a router or view.
- Specific report routes must be mounted before `/api/reports/:id/:section`. In particular, the compliance router precedes the reports router. A contract test guards this order.
- `src/api/jobs/lifecycle.js` owns phase transitions. A stopped or partial report is not a completed scan and must not mark missing backlog items as fixed.
- Keep `src/server.js` exports (`app`, `createDashboardApp`, `localRequestGuard`, `updateJobFromEvent`, `settleJob`, `STOPPED_PHASE`, `listenErrorMessage`) and the `public/app.js` `renderNvdaRun` re-export compatible with existing callers.
- Keep the `src/scanner/crawler.js` and `src/assistive-technology/nvda.js` compatibility facades stable. Implementations import their dependencies directly, never their facade. Architecture tests reject cycles and imports back into these facades.
- Do not move `src/config.js` without reviewing root-relative paths and environment loading. Never copy secrets from `.env` into code, tests, reports, or documentation.

## Crawler ownership

The modules under `src/scanner/crawl/` have these responsibilities:

| Module | Owns |
| --- | --- |
| `run.js` | Overall scan lifecycle, authenticated browser, report checkpoints, completion and cleanup |
| `queue.js` | Discovered routes, deduplication, replay-path upgrades, and application-created tab visits |
| `page.js` | One page's baseline, check ordering, navigation discovery and interaction exploration |
| `interactions.js` | Bounded state traversal, safe action/replay decisions, shared-state reuse and blocker records |
| `checks.js` | Per-frame accessibility checks and browser accessibility-tree snapshots |
| `findings.js` | Finding deduplication, evidence attachment and review classification |
| `navigation.js` | Protected-route opening, URL scope, redirects and landing-origin exclusions |
| `identity.js` | Stable IDs for states and evidence filenames |
| `reporting.js` | Crawl graph, state counts, summary and termination reason |
| `nvda-bridge.js` | Serial crawl-to-NVDA handoff, bounded same-state recovery and explicit replay mode |

The queue receives a session accessor because the authenticated browser is created later. Every scan gets its own queue, visited set, finding maps and evidence registry. Child tabs share the scan's budgets and return to their retained opener; no tab opens merely because these modules are imported.

## NVDA ownership and safety boundaries

`src/assistive-technology/nvda.js` is a public facade. The modules under its `nvda/` folder are:

| Module | Owns |
| --- | --- |
| `capability.js`, `paths.js` | Installed capability checks and repository-relative Windows helper locations |
| `desktop-lease.js` | The single shared desktop lease for live capture, replay and helper warmup |
| `capture-session.js` | Owned reader startup, abort handling, heartbeat, disarm acknowledgement and shutdown |
| `process.js` | Native process checks, guarded launch and PID-specific termination |
| `native-keyboard.js` | Keyboard helper transport, window verification and guarded native commands |
| `browser-focus.js` | Browser-side focus anchors and replay browser preparation |
| `capture-receiver.js` | Authenticated local add-on messages, acknowledgements, speech and completion events |
| `control-file.js` | Atomic control-file writes and bounded Windows sharing retries |
| `speech.js` | Transcript selection and bounded speech/audible-completion waits |
| `live-state-model.js` | State identity, bounded command plan and timing summaries |
| `live-state-runner.js` | Serialized state tests, command execution, retries, required-field evidence and partial results |
| `live-evidence.js` | Per-session screenshot deduplication |
| `tab-scope-watch.js` | Bounded focus checks with cancellation generations |
| `scope-recovery.js` | One verified native scope handoff; marker cleanup only after the caller disarms or stops |
| `replay.js` | Explicit historical replay workflow; never an implicit fallback for a missing live result |
| `text.js` | Small result/error-format helpers |

`nvda-live.js` composes these modules and owns startup, close listeners, pause deadlines, recovery counts, and tab transfers. Its state runner receives read-only live getters rather than copied lifecycle flags: if the tab closes during an awaited command, subsequent code must observe the latest shutdown state. The test runner cannot silently create a second process, enlarge browser scope, or declare an interrupted state complete.

## Local development and verification

Run the dashboard visibly in your own terminal:

```powershell
npm start
# Ctrl+C in this terminal stops the dashboard.
```

Use `npm run dev` only if you want automatic Node restarts while editing. A restart can interrupt an active scan. These commands do not install a service or register a startup task.

For a code change:

```powershell
npm run test:architecture
npm test
npm run test:browser
npm run test:nvda-addon
```

The architecture tests check import resolution, cycles, feature import side effects, compatibility exports, native helper paths, the shared desktop lease, queue isolation/exclusions, scope-recovery cleanup order, API guards, static module serving, route precedence, job isolation, scan options, and partial/failure handling. The API/engine tests use stub runners: they never launch a browser or NVDA. The browser suite uses synthetic local sites, headless browsers, temporary servers, and mock NVDA where needed. It makes no paid AI calls and does not prove real speech output.

Real Chrome/NVDA tests are a separate, explicitly invoked desktop activity. They take foreground focus and speak; do not run them unattended or while someone uses the desktop. Do not claim real speech, focus ownership, or tab-close shutdown is verified merely because the mocked suite passes.

## Invariants to preserve

- Credentials and entered values stay local and out of public job responses and reports.
- Do not click entries apply to every relevant action path, not only a UI label filter. Server-configured exclusions cannot be erased by an empty dashboard field.
- Dialogs containing existing user input, authentication steps, and consequential actions retain their safety guards.
- NVDA evidence must belong to the verified test browser/state. Missing, interrupted, blocked, or timed-out evidence must remain explicitly incomplete.
- Required-field markers are evidence to evaluate, not permission to alter the tested website or fabricate speech.
- No findings does not mean full WCAG conformance. Manual reviews, scope limitations, and draft VPAT/ACR status must remain truthful.

## Future changes

No replacement framework is required for this structure. Extend the module that owns the behavior, retain its public interface, add a focused regression test, and run the full suites. Native focus, process ownership, and speech changes additionally require an approved real-desktop test before claiming live NVDA verification. Structural tests and mocked speech do not establish complete WCAG conformance or multilingual coverage.
