# RAMBO — AI Accessibility Automation Agent

Clarity is a local-first accessibility crawler and reporting dashboard. It uses Playwright and axe-core for the zero-cost baseline, conditionally escalates uncertain image descriptions to a vision model, records issue-highlighted evidence screenshots, and generates JSON plus VPAT/ACR-ready CSV outputs.

For a plain-language explanation of every dashboard option, its purpose, examples, and limitations, read the [dashboard user guide](docs/dashboard-user-guide.md).

For UI integration, use the [Swagger/OpenAPI specification](docs/openapi.json) (also served by the dashboard, see [API documentation (Swagger)](#api-documentation-swagger)), the [endpoint inventory](docs/api-inventory.md) and the [API handoff guide](docs/api-handoff.md).

## What is implemented

- Secure `.env` configuration and saved login sessions stored per user outside the project folder (`%LOCALAPPDATA%\RAMBO\sessions`, or `AUTH_STATE_DIR`), encrypted with Windows DPAPI for the current Windows user.
- Chromium orchestration with automatic login-control discovery and optional selector overrides.
- axe-core scanning of documents, open Shadow DOM, and first-party frames. Third-party frames (ads, video players, chat widgets, CAPTCHA) are skipped and listed in the report limitations unless `SCAN_THIRD_PARTY_FRAMES=true`.
- Same-origin breadth-first crawling, including hash-routed SPAs, with configurable page/depth limits and destructive-route exclusions.
- Browser dialog handling, explicit modal-trigger discovery, `target="_blank"` popup links, and runtime new-window route collection.
- Shared navigation readiness checks wait for DOM content, full load, network settling, visible busy indicators, and a quiet DOM before scanning each page or continuing an authentication step.
- The interactive crawl graph records observed page and dialog states, scanned/failed status, state fingerprints, and labeled navigation or popup actions, including links found inside open Shadow DOM.
- A bounded interaction crawler explores labeled buttons, tabs, menu items, JavaScript-driven role controls, and clickable `div`/`span` containers. It restores and replays state paths, waits after each action, and uses separate Page limit, State limit, and Depth settings to control coverage.
- Page limit (`MAX_PAGES`) bounds distinct page URLs; State limit (`MAX_STATES`, default 100, maximum 500) bounds the combined page/interaction-state budget. A Page limit of 1 still allows same-page dialogs, tabs, and controls to be inspected within the state budget. Depth is the maximum navigation/action-chain length; Depth 0 intentionally inspects only the starting state. Reports record discovered candidates, attempted actions, observed states, routes, and restoration failures so bounded coverage is explicit. Reaching a page or state cap means partial coverage, not a full-site pass.
- The optional **Do not click in this application** field accepts multiple entries, one per line or comma-separated: visible text or accessible names (the whole label, or whole words or phrases within it, so `Pay` blocks "Pay now" but not "Payroll"), image alternative text, titles, any attribute value of the control or its images (id, class name, `name`, `data-*`, `aria-*`, `href`, `src`), `attribute=value` pairs, CSS selectors such as `#delete` or `button.danger`, and link/image URLs (absolute or `/relative-path`). Values typed into form fields are never used for matching. Text ignores case and extra whitespace; URLs retain case-sensitive paths and query values. Image links, nested labels, `aria-labelledby`, and open-shadow controls share the same matching policy. Every matching control is excluded, not just the first. The application-origin-scoped guard filters navigation/document discovery and deterministic/AI candidates, rechecks before clicks (including replay, login and context selection), and blocks excluded activation events in the scan browser. An excluded required login/dismissal action requires user review rather than silently bypassing the rule. It does not hide the element from accessibility auditing or prevent the website's own background activity. Generic visual descriptions and regex are not interpreted; use actual naming/attribute metadata, a supported CSS selector, or an image/link URL. Up to 100 entries of 2048 characters are accepted; excessive entries are rejected rather than silently truncated. Use a JSON array in the API for names or URLs containing literal commas. No provider names are hardcoded.
- When Conditional Vision AI is enabled and deterministic crawling produces no new route or UI state (after `AI_CRAWLER_STALL_MS`, default 5 seconds), a numbered-DOM fallback deduplicates visible semantic elements (including text, labels, inputs, containers, and open Shadow DOM), draws number badges, sends a numbered viewport screenshot plus sanitized metadata through the Responses API, validates the structured numeric choice, and clicks the selected element through Playwright's actionability checks. Unsafe, destructive, registration, credential, payment, logout, and form-mutation actions remain blocked.
- Destructive actions, form submissions, mutating form roles, disabled controls, and unlabeled controls are excluded from automatic clicking. The label guard covers English plus common Spanish, French, German, Portuguese, Italian, Dutch and Hindi verbs; short imperative button labels such as Leave, Download or Accept are also skipped (a link with the same text is still followed as navigation). Click markers are regenerated for every inventory, so a control that changed after it was discovered is re-checked before it is clicked.
- Header, navigation and footer menus are scanned once per site: when the same shared menu opens on another page, its state is linked to the earlier scan instead of consuming the state budget again. A finding in that shared navigation is recorded once with the other pages listed.
- Navigation uses a resilient commit-plus-readiness strategy so slow SPAs that delay `DOMContentLoaded` do not terminate the crawl. Generic loading screens are awaited. The quiet-DOM settle ignores carousels, tickers, clocks, media and live regions, so animated pages do not hold every click for the full wait. An interaction-triggered sign-in gate reuses the credentials supplied for that scan only on an authentication route (the configured login page, an identity provider or an obvious login path) and only for a plain sign-in form: registration, password-change, profile and user-management forms never receive credentials. Credentials are never typed into a page with a certificate error unless `IGNORE_HTTPS_ERRORS=true`.
- Authentication entry screens with a Sign in context and a generic Continue control are handled before searching the redirected identity-provider page for email and password fields.
- After authentication, this handler remains dormant unless a visible blocking dialog, modal, or popover actually appears. Inside that obstruction, domain, tenant, workspace, organization, company, or client choosers can be completed with the optional value supplied in the scan form (for example, `JCB`). During the crawl only a single-field picker (a search/combobox field or a "Select/Choose … workspace" dialog) is treated as a chooser; multi-field forms such as "Add client" or "Contact us" are never typed into and never stop the crawl. Exact visible matches are selected, and ordinary Close, Dismiss, Not now, Skip, Cancel, X, or × controls can be used to clear non-security dialogs. A dialog that keeps reappearing is retried at most twice.
- The scan form displays live phase, progress, elapsed time, current URL, recent steps, recoverable warnings, and a focused failure alert with retry guidance when a scan stops.
- Page readiness is driven by visible, meaningful application content. A full-page blocking loader waits, while a usable form or dashboard proceeds even if a small spinner or progress widget remains.
- One-time OAuth/OIDC callback URLs containing authorization `code` and `state` values are never reloaded to discover controls. The already-rendered authenticated state is inventoried first, and transient navigation is retried before declaring that no controls exist.
- Interaction crawling no longer performs a final page reload after its work is complete. Required state restoration reuses the already-open root state when possible, waits for a competing OAuth redirect to settle, and removes authorization values from diagnostic messages. Evidence is discarded if the underlying document changes before its screenshot is captured.
- If a protected application state cannot be reconstructed safely, the crawler tries dismissing transient UI and browser-history recovery for both SPA and MPA navigation. A remaining failure skips only that branch after 50 seconds, records a coverage warning, and continues instead of aborting the entire page. A restore is skipped entirely when the page is still in the required state, and state fingerprints ignore carousel, ticker and live-region text and changing numbers so rotating content does not force reloads or create duplicate states.
- Full keyboard traversal (up to `KEYBOARD_MAX_TABS`, default 120 Tab presses per page) with checks for focus visibility (2.4.7), focus hidden behind sticky content (2.4.11), keyboard traps (2.1.2), focus-order jumps and positive `tabindex` (2.4.3), custom controls that cannot take focus, and controls removed from the tab order (2.1.1). Traversal starts at the top of the document without clicking anything. "Unreachable" is reported only after a complete traversal with no trap; composite widgets and radio groups are excluded because they use arrow keys.
- Zoom, reflow and text-spacing checks: each page is checked at a 640 px viewport (200% zoom on a 1280 px screen, 1.4.4), at 320 px (1.4.10), and with the WCAG 1.4.12 text-spacing styles applied. Horizontal scrolling and clipped text are reported with a screenshot taken under that condition. The viewport is restored afterwards; the shared NVDA window is never resized.
- Media checks for `<video>`, `<audio>` and embedded players: missing captions, audio description, pause controls, autoplaying sound, transcripts and moving content (1.2.x, 1.4.2, 2.2.2). Embedded third-party players are flagged for manual review.
- Document checks: same-site PDF links are downloaded (up to `DOCUMENTS_MAX`, default 10) and checked for tags, title, language, image-only pages, figures without alternative text, bookmarks and unlabelled form fields. Signed download URLs are kept in memory only and never written to the report. Word, Excel and PowerPoint links are listed for manual review.
- Progress is checkpointed after every page. A crash or server restart leaves a partial report marked **interrupted** (or **failed**) instead of losing the run.
- Optional, element-cropped vision review of images that already contain custom alt text.
- Per-finding screenshots with a red bounding box and WCAG/rule label drawn over the affected element.
- Needs-review findings are listed beside confirmed issues, include highlighted evidence when the element remains stable, fall back to a clearly labeled page-context image when necessary, and retain a review-history entry explaining why human judgment is required.
- Interactive crawl graph connecting pages, links, and popup routes.
- Complete WCAG 2.1/2.2 A/AA reporting registry with per-rule observations and evidence-backed manual review. Automated issue severity never determines a conformance decision; all criteria remain `Not Evaluated` until a documented reviewer decision.
- `vpat_draft.json` and `ACR_VPAT_Report.csv` for every completed run, plus VPAT® 2.5-structured exports (WCAG, Section 508, EU EN 301 549 and International editions) in HTML and Word.
- Scripted journeys (login, KYC forms, statements) with masked test data, declared environments and an origin guard; a remediation backlog that tracks findings across scans; GIGW 3.0 and SEBI checklists with an import for licensed IS 17802 checklists; mobile-viewport scans and native Android screen checks.

## Run locally

Requirements: Node.js 20 or newer.

```powershell
Copy-Item .env.example .env
npm install
npm run install:browsers
npm start
```

Open [http://localhost:4173](http://localhost:4173), enter the application URL, and start a scan.

The default `BROWSER_CHANNEL=bundled` uses Playwright Chromium only. To use the installed Google Chrome build of the same Chromium engine instead, set this in `.env` and restart the server:

```env
BROWSER_CHANNEL=chrome
```

You can also run the scanner without the dashboard:

```powershell
npm run scan -- https://your-application.example
# add --ai to enable the optional OpenAI checks for this run
```

### Tests

```powershell
npm test                 # unit/API and headless lifecycle checks; no live NVDA
npm run test:architecture # module boundaries and API wiring
npm run test:browser     # all local browser fixtures; no real NVDA, paid AI or external sites
npm run test:nvda-addon  # NVDA capture add-on unit tests (Python 3)
```

Individual feature checks (all local, synthetic pages): `test:keyboard`, `test:adaptation-media`, `test:documents`, `test:remediation`, `test:vpat`, `test:journeys`, `test:compliance`, `test:mobile` and `test:nvda-after-crawl`.

## API documentation (Swagger)

The backend API is described in [docs/openapi.json](docs/openapi.json) (OpenAPI 3.0.3, 37 operations), with an endpoint table in [docs/api-inventory.md](docs/api-inventory.md). The dashboard serves both a Swagger UI page and the raw document:

```powershell
npm start
```

- Swagger UI: `http://localhost:4173/api-docs`
- Raw OpenAPI JSON: `http://localhost:4173/api/openapi.json`

Replace `4173` with your `PORT` setting if you changed it. The server listens on 127.0.0.1 only, and the localhost request guard also applies to these pages. Swagger UI loads its files from cdn.jsdelivr.net, so that page needs internet access; the raw JSON does not. **Try it out** sends real requests to your server, so `POST /api/scans` starts a real scan. The API has no authentication; the document's description explains the localhost `Host` and `Origin` checks.

After changing routes or request/response models, update `docs/openapi.json` and validate it:

```powershell
npm run test:openapi
```

This runs `test/openapi.test.js` (also part of `npm test`), which needs no extra packages, no browser and no network. It validates the document's structure, `$ref`s and every example; confirms that every Express route is documented and every documented path reaches that route; and calls every documented operation on an in-process server with a temporary reports folder, checking status codes, content types, response schemas and the documented error messages. `node scripts/validate-openapi.js` is a quicker structure-only check. `docs/openapi.yaml` is an earlier snapshot, replaced by `docs/openapi.json`.

## Authentication

For different applications, enable **Website requires login** in the dashboard and enter the login-page URL, username, and masked password. These values are sent only to the local server for that scan and are not stored in reports. When **Remember the authenticated session** is enabled, only the resulting cookies and local storage are saved, per application host, under `%LOCALAPPDATA%\RAMBO\sessions` (outside the project folder).

Leave **Advanced login selectors** blank for automatic discovery. The agent uses field types, associated labels, accessible names, placeholders and safe Sign in/Log in/Continue controls, including frames and open Shadow DOM. It skips disabled/read-only fields and never types passwords into unmasked controls. The advanced section is only an optional override for an unusual form; existing explicit selectors take precedence.

The dashboard checks `/api/health` before transmitting credentials. **Scanner backend disconnected** means the local server is unreachable, not that a login locator is missing: run `npm start`, leave that terminal open, and open the localhost address printed there. If a scan POST loses its response, the dashboard does not automatically resend it because the first request may already have started a scan.

`npm run test:auth-auto` verifies automatic discovery using only local synthetic forms and credentials, without AI, saved sessions, NVDA or an external application.

Username-first providers such as Azure B2C are supported: the agent fills the username, activates Continue/Next, waits through redirects and frames, then fills the password stage.

If the application displays a required domain, tenant, workspace, organization, company, or client chooser after login, enter its exact value in **Domain / tenant / workspace** before starting the scan. If the value is omitted, the scan stops at that chooser with an instruction to enter it and retry. Ordinary post-login notices may be closed automatically; CAPTCHA, MFA, consent, permissions, passkeys, and other security prompts are never dismissed automatically.

The configured authentication URL may be either a direct login page or an application landing page. On landing pages, the agent discovers safe authentication-entry controls such as Log in, Sign in, My account, and identity-provider buttons before locating the credential fields. It intentionally does not click arbitrary DOM actions because unrelated buttons can have destructive business effects.

When `OPENAI_API_KEY` is configured, the dashboard can enable an AI-assisted fallback for unfamiliar login DOMs. It uses the Responses API with structured JSON output and sends only sanitized control metadata such as labels, roles, element types, and placeholders. Usernames, passwords, field values, cookies, tokens, and storage state are excluded. API responses use `store: false`.

The agent does not bypass CAPTCHA, MFA/OTP, passkeys, security keys, biometric checks, or device approval. These controls intentionally require user action; the scan stops with an actionable message instead of weakening the authentication boundary.

Environment variables (`LOGIN_URL`, `LOGIN_EMAIL`, and `LOGIN_PASSWORD`) remain available for unattended CLI scans, but they are not required for dashboard scans.

For SSO, MFA, CAPTCHA, or passkey flows, create a saved session using an approved interactive login process. Do not attempt to bypass those controls.

Saved sessions contain live cookies. On Windows they are encrypted with DPAPI for the current Windows user and written to `%LOCALAPPDATA%\RAMBO\sessions\auth_state.<host>.json.dpapi` (or `AUTH_STATE_DIR`), not the project folder, so zipping or sharing the workspace does not include them and a copied file cannot be used by another account or machine. Plain sessions saved by earlier versions are still read and are replaced by an encrypted copy at the next save. To convert them now, run `npm run sessions:migrate` (a dry run that lists what it would do), then `npm run sessions:migrate -- --apply`, which verifies each encrypted copy before deleting the plain file.

## Vision AI cost control and data handling

Vision review is disabled unless both conditions are true:

1. `OPENAI_API_KEY` is present.
2. “Conditional vision AI” is enabled for the scan (dashboard checkbox, off by default), `npm run scan -- <url> --ai`, or `AI_ENABLED=true`. An API key alone never enables AI.

The alt-quality path sends only cropped visible `img` elements with non-empty custom alt text. The stalled-crawl numbered-element path sends one numbered viewport screenshot plus sanitized DOM metadata after `AI_CRAWLER_STALL_MS` (default 5 seconds) without progress. Passwords, input values, cookies, storage, tokens, and hidden elements are excluded, and emails and long numbers are scrubbed from labels; visible page content in the screenshot is necessarily included. Do not enable AI for applications whose screens may not leave the organization. API responses use `store: false`.

## Local dashboard security

The dashboard has no login and serves screenshots of the sites it scanned, so it listens only on `127.0.0.1` and accepts only requests addressed to `localhost`, `127.0.0.1` or `[::1]`. This blocks DNS-rebinding pages from reading reports or starting scans with your saved sessions. State-changing requests from another origin are rejected. Add other hostnames only if you understand the exposure: `DASHBOARD_ALLOWED_HOSTS=myhost`.

## Reports

Each run creates:

```text
reports/<run-id>/
├── vpat_draft.json
├── summary.json            # small listing record used by the dashboard
├── ACR_VPAT_Report.csv
├── ACR_VPAT_Report.html
└── evidence/
    ├── baselines/
    └── <finding screenshots>.png
```

The JSON file is the canonical report. The CSV is a review draft, not a legal declaration of conformance. `vpat_draft.json` is saved after every page with `status: "in-progress"`; a completed scan writes `status: "complete"` and the exports, and a scan that stops early is shown as interrupted or failed with the results gathered so far.

Confirmed findings contain only rules mapped to a WCAG criterion. axe best-practice rules with no criterion (for example `region` or `landmark-unique`) are kept in a separate **Best practice** group (`bestPractices` in the JSON, the **Best practice only** filter in the dashboard); they are not confirmed WCAG failures and are not scored. Older reports are presented the same way when opened; their files are not rewritten.

The dashboard opens the latest completed report on load. Use **Saved reports** to inspect a different execution, or press **Compare reports** to enter a separate comparison workspace. There, choose any two completed scans in either order and press **Compare**; the agent determines which is earlier. Once one report is chosen, reports from other hostnames are disabled; the API also rejects cross-site comparisons. The delta grid groups confirmed WCAG findings by criterion, rule, page/state, and element path into new, fixed, and unresolved categories. Select a finding or its **View screenshots** button to inspect saved visual evidence from the earlier and later scans side by side. New issues use their later highlighted capture, fixed issues use their earlier highlighted capture, and unresolved issues can show both. A saved page baseline may supply context on the other side, but is explicitly labeled as context rather than evidence of a pass; missing captures are labeled rather than fabricated. The comparison workspace shows two independently labeled crawl graphs—one from each execution—without altering the single-report graph. Findings on pages or states not scanned in both runs, or with an uncertain counterpart, are excluded from new/fixed claims and counted in the comparison note. An absent finding is not proof of a WCAG pass.

## Dashboard assessment and API

The dashboard shows an **observed accessibility health** score from 0–10 and a provisional grade (A+ through F). Confirmed WCAG findings are weighted by impact and normalized by successfully scanned pages (`10 × exp(−weighted findings ÷ (10 × scanned pages))`); findings that need review and best-practice findings do not count. Recording more (or duplicate) interaction states no longer raises the score. The score is computed when a report is opened, so older reports are also shown with this method and can differ from scores noted earlier (methodology version 1 divided by states). Older reports also still count a shared-navigation finding once per page, so they may score lower than a new scan of the same site. The score card separately shows scan coverage and confidence. It is a heuristic for prioritizing work, **not** a WCAG conformance certification or proof that unobserved routes pass.

The original `GET /api/reports/:id` JSON remains intact. Read-only dashboard endpoints are `GET /api/reports/:id/overview`, `/score`, `/issues`, `/pages`, `/graph`, `/activity`, `/acr`, `/evidence`, and `/assistive-technology`. Evidence entries include local image URLs when the saved path is valid. The existing `GET /api/reports/:id/compare/:previousId` endpoint remains the separate, same-application comparison view.

## Screen-reader readiness

Each observed page and interaction state is inspected through Chromium's accessibility tree. The report records exposed roles, names, values, descriptions, states, landmarks, headings, dialogs, live regions, named controls, unnamed controls, structural warnings, and a compact approximation of the announcement sequence. This validates the browser surface that assistive technologies consume and is shown in the dedicated **Screen-reader readiness** dashboard tab.

This inspection is deliberately not presented as execution with an actual screen reader. Reports explicitly record NVDA, JAWS, VoiceOver, and TalkBack as `not-run` unless a platform-specific adapter genuinely executes that product. The optional NVDA adapter below is the first such adapter. NVDA and JAWS require Windows installations, VoiceOver requires Apple hardware and operating systems, and TalkBack requires an Android device or emulator. Human workflow validation with the required screen-reader/browser combinations remains necessary.

### Optional actual NVDA website test (Windows)

The application can run explicit, opt-in NVDA checks. `npm start` remains the server command. When NVDA is selected, it starts once during preparation of the maximized visible Windows browser. The default is **scan the current state → wait for its NVDA checks → move to the next safe state** (`NVDA_MODE=during-crawl`). NVDA uses the crawler's current tab and authenticated state; it does not need to reopen a menu or dialog in a second tab. Waiting for speech adds to scan duration. A missing or failed NVDA setup is recorded as unavailable or blocked and does not turn the accessibility scan into a pass. Optional `NVDA_MODE=after-crawl` retains historical replay; states that cannot be recreated are reported as not tested, with the original replay failure preserved instead of a misleading cleanup/tab-closed error.

NVDA runs against **states**, not just distinct URLs: default views, menus, dialogs and tabs can each have a result, transcript and screenshot. Checks include actual Tab-focus announcements, read-to-end Say All, heading navigation and table-navigation samples when available. Add-on 1.9.1 or newer is required; it attempts to finish the available browse content, with a five-minute safety budget per state (`NVDA_READING_TIMEOUT_MS=300000`, configurable up to 1800000). Completion requires spoken content, an end-of-browse-content position and an audible-completion acknowledgement. A timeout, lost focus or unconfirmed end is reported separately, never as completed reading. This is not proof that hidden, unvisited, virtualized or inaccessible content, every table cell or an entire website was read. Crawler actions and NVDA commands are serialized. Meaningful route/dialog/tab changes stop the current NVDA state's commands and are recorded for review; routine rotating text alone is not treated as leaving that state.

Before each state, the agent focuses its temporary marker through Windows accessibility, inside the current document or visible dialog. This corrects cases where DOM focus reports success while native focus remains in Chrome's toolbar. The handoff does not click application controls, send pane-switching keys, or move focus from another application. It requires the exact testing window, process and title, a unique document marker, and an unchanged UI state; failure is reported as blocked rather than executed.

`NVDA_MAX_STATES` (default 100, maximum 500) is independent of crawl page limits; skipped states are explicitly counted. `NVDA_MAX_PAGES` is no longer used. A one-page application can therefore produce many NVDA state results. Old reports remain labeled **Legacy page-only run** and are not presented as state coverage. Restart `npm start` after backend updates; refreshing the dashboard does not reload server code, and historical reports are not rewritten.

1. Install the current NVDA release on the Windows machine that runs the agent.
2. Run `npm run install:nvda-addon` to copy the included local speech-capture add-on into `%LOCALAPPDATA%\RAMBO\nvda-profile`.
3. Set `NVDA_ENABLED=true` in `.env`. Set `NVDA_PATH` only if NVDA is not in a standard install location. If you choose a different profile directory, set the same value in `NVDA_CONFIG_PATH` and pass it to the install script with `-ConfigPath`.
4. Start the application with `npm start`. The scan form enables the NVDA checkbox only when the Windows session, NVDA executable, and keyboard helper are available.
5. Keep the Windows desktop unlocked and interactive during the NVDA-enabled crawl. Do not use the keyboard or change focus; a dedicated Windows test machine/session is preferable.

The native helper warms up in parallel with Chrome launch. By default NVDA starts during browser preparation, before login or application navigation. Add-on 1.7.1 / protocol 6 acknowledges the completion of NVDA core startup. During initialization, speech and test commands remain disabled; NVDA's Windows startup notification can briefly activate Settings. The agent performs one startup handoff to the original verified Chrome window, confirms native document focus and receives an acknowledgement that the test scope is enforced before opening the application. This handoff only runs during initial preparation. Startup time is recorded as `startupTiming`; Windows/NVDA initialization still takes time and there is no zero-latency guarantee.

During testing, closing/crashing the test tab or disconnecting Chrome stops the owned reader and cancels remaining NVDA commands. With the current pause-capable add-on, moving focus away pauses testing; it can resume only after the original test scope is verified again, within configured pause/recovery limits. Startup failures and older add-ons fail closed. The testing page disables Playwright's simulated focus so a background tab cannot appear active to the guard. Returning to the tab does not silently restart a canceled reader. The report retains completed evidence and records why remaining checks stopped. Speech is quiet during setup/login and is allowed only for actual website test commands. Existing application controls are not clicked by startup preparation. Native foreground checks run between commands, and capture readiness is acknowledged only after NVDA recognizes focus inside the marked website document. Capture disarming is acknowledged before temporary page titles are restored.

During-crawl recovery is a serialization barrier: the crawler waits while NVDA tests or recovers the current state. Recovery restores the exact owned Chrome window and native document focus, checks that the route/dialog/controls have not changed, and skips completed test categories. Interrupted transcripts, screenshots and attempt history remain in the report. If recovery fails or reaches its bounds, the crawl stops with a **partial report**, not a successful completion or an empty "not executed" result. A natively verified Tab into Chrome's toolbar ends that state's Tab traversal; restoring document focus does not consume the unexpected-focus-loss allowance. No further toolbar keys are sent. These controller fixes do not require reinstalling an already-installed add-on 1.9.1; restart the backend and run a new scan. `/api/health` identifies this backend as `accessibility-nvda-recovery-44`, with `nvda.recovery: same-state-bounded-v2`.

Add-on 1.7.2 also turns off NVDA's automatic update check in the agent's own test profile (`[update] autoCheck = False` in that profile's `nvda.ini`), so an update prompt cannot take focus during a run; your personal NVDA configuration is not changed.

NVDA is still a Windows desktop process; this integration controls when that process exists. A manually running NVDA instance must be exited before testing; the agent does not borrow or terminate a personal reader. Normal shutdown is requested through the owned add-on, with a fallback that targets only the captured process ID. The reader also exits if its controller disappears or its renewed session lease expires. **Reinstall the bundled add-on after this update, exit NVDA and restart the server**. Configure optional bounds with `NVDA_TESTS`, `NVDA_READING_TIMEOUT_MS`, `NVDA_HEADING_STOPS`, `NVDA_TABLE_STOPS` and `NVDA_TAB_STOPS`. Existing reports are historical and will not acquire new test evidence automatically.

`NVDA_STARTUP_TIMEOUT_MS` is a maximum readiness deadline (default 60 seconds, configurable from 1 to 300 seconds), not a fixed sleep. Cold Windows/NVDA startup can exceed 20 seconds. The inactive authenticated lease is renewed during initialization; readiness proceeds as soon as NVDA core startup completes. Initialization also has an absolute deadline. Closing the test tab cancels startup. During testing, bounded recovery can bring the owned Chrome window forward again; it never sends test keys before verifying the original tab and document scope. Keep the desktop dedicated to the test.

`npm run test:nvda-live-crawl-browser` is an explicit **real desktop** regression: it runs the actual crawler and NVDA on a local English home view and dialog, checks reading-end markers, heading navigation, native Tab announcements and screenshots on both states, and verifies the owned reader exits. Keep the desktop idle. `npm run test:live-nvda-crawl` instead checks sequencing, same-state recovery and partial-report cancellation with a mock reader in a headless browser; it is not evidence of real speech.

Per-command latency: native keys go through one long-running keyboard helper (`scripts/windows/key-server.ps1`) instead of a new PowerShell process per key; the same foreground, PID and title-marker guards run for every command, and the per-call `send-keys.ps1` is used only if the helper cannot start. The add-on checks its control file every 50 ms and posts each transcript as soon as it is captured. Listener-friendly speech defaults to `NVDA_SPEECH_RATE=40` on NVDA's 0–100 scale, with rate boost off and `NVDA_FAST_SPEECH=false`. Lower the rate to slow it further; maximum-speed speech is an explicit opt-in. Focus, heading and table commands wait for the actual synthesizer's completion, including a quiet interval, before disarming capture or advancing. Their audio wait is bounded at 30 seconds; unconfirmed completion is marked for review. Say All uses the longer reading budget described above. Each tested state starts at its top (or the active dialog's focus anchor), so later routes do not silently skip their headers. Announced stops keep their transcript and focus record, and a screenshot is saved for stops that need review (`NVDA_ACTION_SCREENSHOTS=all` saves one for every stop). A single failed tab-context check no longer stops the reader: speech is muted immediately and the reader exits only after three consecutive failures (about 300 ms). Every command records `timing` (arm, key, first speech, speech, disarm, inspection, total), and the NVDA result includes median `timing` per command type so slow runs can be diagnosed.

After installing this update, restart the agent server and run a new scan; old reports remain unchanged. On a free, unlocked desktop, `npm run test:nvda-reading` opens a local English sample and verifies the final sentence, end position and audio completion using actual NVDA. It saves local diagnostic evidence. Do not run it alongside other desktop/NVDA tests. This does not validate pronunciation, multilingual switching, forms or complete business journeys; human listening and task-based testing remain necessary. Existing explicit timeout settings in `.env` take precedence over the new default.

When NVDA says nothing after a key, the agent normally waits the full bounded interval (about 2 seconds with the default `NVDA_ANNOUNCEMENT_WAIT_MS`). Set `NVDA_SILENT_WAIT_MS` (for example 1000) to stop waiting sooner on silent stops. Speech that has started is never cut short, Say All ignores this setting, and a stop ended this way is marked `silentCutoff` with a note to confirm the silence by ear. Check `firstSpeechMs` in a real run before lowering it: a value below NVDA's usual first-speech time on your machine will turn slow announcements into false "silent" results.

Application-created child tabs on the same origin are inspected in their actual opened browser page, within page/state/depth limits. The original tab stays open; returning does not navigate it home or reload it. Existing inputs are not rewritten, and retained focus/scroll are restored. If the application changes the original state while its child is open, the report warns rather than claiming that state was preserved. External-origin tabs are skipped. Already-visited URLs remain deduplicated; this is not exhaustive coverage of every separate tab at the same URL.

In the default `NVDA_MODE=during-crawl`, the reader can transfer to a verified application-created child and back through an acknowledged scope handoff. An unverified tab gets no attributed NVDA result. This does not permit NVDA to keep testing invisibly while the user works in another tab or application. Optional after-crawl mode still depends on state replay; opener-dependent child states may not replay successfully. `npm run test:tab-switching` checks the local headless workflow and mock NVDA hooks; `npm run test:native-browser-windows` tests native-window selection using fake windows, without desktop input. Neither establishes real speech behavior across tabs.

`npm run test:live-nvda-crawl` verifies state timing with a mock adapter and is not a real NVDA test. After updating the add-on, `npm run test:nvda-live-browser` is the explicit native smoke test: it opens Chrome, runs the real reader on a local synthetic page and dialog, checks transcripts/screenshots/unchanged inputs, then verifies that closing or leaving the test tab exits the actual NVDA process. Keep the desktop free of other keyboard activity for that test.

Form completion, MFA, transactions and complete user journeys are **not** automated by this generic NVDA adapter. No normal input is filled or submitted by these checks. Exact speech and task usability require an experienced screen-reader reviewer. JAWS, VoiceOver and TalkBack remain `not-run` unless their own real adapters execute them. Captured speech, a completed command, or zero review warnings is not a WCAG pass.

Required-field observations: at reached NVDA Tab stops, the agent reads native HTML `required`, `aria-required="true"`, required/mandatory wording in associated labels/descriptions, and associated asterisks (including CSS-generated and adjacent markers). A star with a matching explanation in the same form is treated as an expected requirement; an unexplained star is only a candidate for review. Conflicting optional/required indicators also need review. The dashboard shows the detected indicators and whether the **actual focus announcement** communicated required/mandatory, with confirmed execution and audible completion. Missing or ambiguous speech is **Needs review**, not an automatic WCAG failure. The checker does not change the application, inject speech, fill or submit inputs, or save entered values in its field metadata. Speech-word matching currently covers English; other languages need manual review. It does not claim coverage for unvisited fields, inaccessible frames, or closed shadow roots. Run `npm run test:required-fields` for synthetic headless DOM checks (no real NVDA); unit tests also verify speech assessment and the live-run integration. Restart your own `npm start` session and create a fresh report to use the feature; no add-on reinstall is required for this controller-only change.

## Scripted journeys

Journeys drive a fixed sequence of steps (for example sign in, open statements, fill a KYC form) and scan each checkpoint, which the generic crawler deliberately does not do. Put a journey file in `journeys/` and its test data in `journeys/testdata/` (ignored by Git, except the example). See `journeys/example-sandbox.json`.

- Steps: `goto`, `click`, `fill`, `select`, `check`, `uncheck`, `press`, `waitFor`, `assert` and `checkpoint`. Targets use a label, role and name, text, placeholder, test id or CSS selector.
- `environment` must be `sandbox`, `staging` or `production-read-only`, and `allowedOrigins` lists every website the journey may visit. Leaving those origins stops the journey.
- Values written as `{{key}}` come from the test-data file and are shown only as `{{key}}` in reports; the actual values never reach a report.
- A step whose control looks like it submits or changes data (Save, Submit, Pay, Enter in a form, and so on) is refused unless the step is marked `"consequential": true`, the environment is not `production-read-only`, and the file has `authorization.reference`.
- `"device": "mobile"` runs the journey in the Pixel 7 emulation described below.

Run one from the dashboard (**Scripted journeys** under the scan form) or with `npm run journey -- journeys/<file>.json`. The result is a normal report with a journey section listing every step and its outcome.

## Remediation backlog

The **Remediation** tab keeps one backlog per site (`reports/_backlog/<host>.json`) that persists across scans. Each completed scan syncs automatically: new findings are added, findings seen again update their last-seen scan, and a fixed or verified item that reappears is **reopened**. A finding that is absent from a later scan is never closed automatically; it is marked "not found in latest scan" so someone can verify the fix. An item cannot be set to Verified while the latest scan still reports it. Set status (open, in progress, fixed, verified, reopened, won't fix, false positive), owner, due date and notes, or download the backlog as CSV. **Track in backlog** on a finding's evidence panel adds a needs-review or best-practice finding manually.

## VPAT 2.5 exports

The VPAT / ACR tab produces a VPAT® 2.5-structured Accessibility Conformance Report in four editions (WCAG, Revised Section 508, EU EN 301 549 and International) as HTML or Word. Enter the product name, version, report date, contact and evaluation methods once per report. Section 508 and EN 301 549 rows outside WCAG (for example 302 Functional Performance Criteria, chapter 5 and chapter 12) take their own documented reviewer decisions. Any row without a decision shows "Not Evaluated", which VPAT 2.5 only permits for Level AAA, so the file is marked **DRAFT** until every row is decided. EN 301 549 V3.2.1 chapter 9 maps WCAG 2.1; WCAG 2.2-only criteria are not listed there. The export is not the official ITI template file and not a certification.

## Regulatory checklists (GIGW 3.0, SEBI, IS 17802)

The VPAT / ACR tab also lists requirement checklists. GIGW 3.0 (78 items) and the SEBI digital accessibility circulars (42 items) are paraphrased from public sources retrieved on the date shown; each item cites its source and link. One SEBI item was read from a scanned circular and is marked for wording verification. Confirm applicability, wording and current deadlines with your compliance team before relying on them.

IS 17802 is a paid BIS standard, so its clauses are not built in. Import your licensed checklist under **Import a checklist** as CSV with a header row (`reference`, `requirement`, and optionally `title`, `category`, `wcag`, `verification`, `source`), or with `POST /api/compliance/sets`. Imported sets are stored in `reports/_compliance/`.

Every item needs a documented decision (met, partially met, not met, not applicable) with reviewer, scope, notes and evidence. Related WCAG results from the scan are shown beside each item for reference and never decide it. Download all checklists with their decisions as CSV.

## Mobile

- **Mobile web:** choose **Mobile (Pixel 7 emulation, touch)** under Viewport, or set `SCAN_DEVICE=mobile`. Chromium emulates the Pixel 7 viewport, touch input and mobile user agent, so responsive layouts, hidden menus and tap-target sizes are scanned as a phone shows them. This is emulation, not a real device or browser. Actual NVDA always uses the desktop window.
- **Native Android apps:** connect a device or start an emulator (for example `emulator -avd Pixel_9_API_35`), open the app, and run `npm run scan:android` (add `--screens 3 --names "Login,Home,Statements"` to capture several screens; you navigate between them). The agent only reads the screen with `adb` (UI Automator hierarchy and a screenshot) and never taps or types. Checks: controls without an accessible name (4.1.2), text fields without a label or hint, images without a content description, clickable elements that are not focusable (2.1.1), touch targets under 24 dp that crowd a neighbour (2.5.8), and best practices (48 dp targets, duplicate labels, "button" in labels). The hierarchy does not expose colours, text scaling or `labelFor`, so those need manual review. The result is a normal report in the dashboard.
- **TalkBack** is not automated; Android speech has no supported capture interface.

## Report clean-up

Reports with screenshots grow quickly. `npm run reports:prune -- --keep 5` lists what would be deleted (keeping the newest five completed reports per site); add `--older-than 30` to limit by age, `--include-interrupted` to include stopped scans, and `--apply` to actually delete. Deletion cannot be undone. Backlogs and imported checklists are never touched.

## General and financial audit workspace

Choose **General website** or **Financial application**, then WCAG **2.1 AA** or **2.2 AA** when starting a scan. Both profiles use the same crawler, authentication, axe checks, screenshots and optional NVDA adapter; there is no application-name-specific audit implementation. The framework contains 50 A/AA criteria for WCAG 2.1 and 55 for WCAG 2.2 (which removes obsolete 4.1.1). A complete registry is a reporting framework, not a claim of automated coverage for every criterion.

The **VPAT / ACR** workspace exposes automated observations beside outstanding manual checks. Reviewers record their name, tested scope/environment, decision, explanation and evidence references. These decisions append to `audit-reviews.json`; the original scan JSON is not overwritten. Confirmed findings prevent a contradictory `Supports` or `Not Applicable` decision for that criterion in that scan. Fixes require retesting, not erasing historical evidence. Reviewer names are self-reported local metadata, not authenticated signatures.

The financial profile adds review tasks for regulatory applicability, GIGW/IS 17802, KYC, authentication, payments, trading, statements/documents, complaints and governance. It is **not a complete SEBI assessment or certification**. Current legal applicability, qualified audit requirements and submission deadlines need the organization's compliance reviewer. Financial actions such as sell, transfer, withdraw, redeem, deposit and order submission are excluded from generic clicking in both profiles. These label/URL safeguards cannot prove every arbitrary website action is read-only: use approved test environments and accounts, especially for financial journeys.

### BFSI / Capital Markets evidence workbook

Financial reports now include a **guided manual assessment** in the VPAT / ACR tab: 32 concrete steps across eight website journeys (onboarding/KYC, authentication/MFA, portfolio/market data, trading/orders, payments/transfers, statements/disclosures, help/complaints, and account settings). Each step includes prerequisites, a procedure, expected outcomes, related version-specific WCAG criteria and evidence guidance. This workbook does not execute the journeys or submit transactions.

Use **Record scenario review** after carrying out an authorized test. Record `pass`, `fail`, `blocked` or `not-applicable`, with the reviewer, actual result/rationale, tested scope, evidence references, build, browser/OS, assistive technology/test method, environment and authorization reference. Optional finding links must belong to that report. A step cannot be passed or excluded while linking an unresolved confirmed finding. Consequential steps cannot be recorded as pass/fail in a production-read-only environment; record blocked if an approved sandbox or staging environment is unavailable.

Unreviewed, failed and blocked steps remain explicit gaps. Mixed-build reviews and an entirely excluded workbook do not establish workflow coverage. Counts describe recorded human reviews, not automatic test results, a compliance percentage or authenticated sign-off. Reviewer identity, qualifications and evidence references are not independently verified. Scenario decisions never automatically change a WCAG conformance decision. Review history is appended separately from the original scan, and current JSON/CSV/HTML exports include the workbook and execution context. General reports do not display or accept financial scenario reviews.

See [Financial assessment operating guide](docs/financial-assessment-guide.md) for a practical audit-to-retest workflow and what is still needed to establish genuine industry experience. `npm run test:financial-workflow` checks the local UI/API/export workflow using synthetic fixtures; it is not a financial-client audit or real transaction test.

Automated rule outcomes record pass/fail/needs-review/inapplicable at each observed frame/state without storing passing-node markup. A passing rule applies only to that rule and state, not the entire criterion or website. Human checks still cover complete keyboard journeys, zoom/reflow, meaningful alternatives, media, authentication, financial error prevention, documents and assistive-technology usability.

API additions:

- `GET /api/reports/:id/audit` — profile, criteria, manual checklist, scope and review summary.
- `GET /api/reports/:id/financial` — guided financial scenarios, recorded evidence and outstanding gaps; `null` for general reports.
- `GET /api/reports/:id/reviews` — review history.
- `POST /api/reports/:id/reviews` — append `{kind, targetId, status, reviewer, scope, notes, evidence: [...]}`.
- `GET /api/reports/:id/exports/json`, `/csv`, `/html` — current working draft including saved reviews.
- `GET|POST /api/reports/:id/vpat-profile` and `GET /api/reports/:id/vpat/:edition/:format` — VPAT 2.5 product details and exports (`wcag`, `508`, `eu`, `int`; `html` or `docx`).
- `GET /api/backlog/:host`, `POST /api/backlog/:host/sync`, `POST /api/backlog/:host/track`, `PATCH /api/backlog/:host/items/:key`, `GET /api/backlog/:host/export.csv` — remediation backlog.
- `GET|POST /api/compliance/sets`, `GET /api/reports/:id/compliance`, `GET /api/reports/:id/compliance/export.csv` — regulatory checklists. Decisions use `POST /api/reports/:id/reviews` with `kind: "compliance-item"`.
- `GET /api/journeys`, `POST /api/journeys/run` — scripted journeys.

These exports are working audit material, not the official ITI VPAT template or an automatically certified ACR. The internal score/grade remains a prioritization heuristic. This local dashboard is not a hardened multi-user audit system; authentication, access controls, sensitive-evidence handling and deployment controls are separate requirements before hosting it.

## Application coverage and honest limits

The scanner is designed for traditional sites, SPAs, server-rendered applications, open Shadow DOM web components, dialogs present in or explicitly opened from the DOM, same-session popups, and frames Playwright can address.

No generic scanner can inspect closed Shadow DOM internals because their owning component intentionally does not expose them. Cross-origin frames, anti-automation challenges, native browser chrome, canvas-only interfaces, and states behind unknown business workflows can also require application-specific adapters. Clarity records these limitations instead of treating inaccessible surfaces as passes. The automated keyboard, zoom, reflow, text-spacing, media and document checks find common failures; they do not replace manual screen-reader, cognitive and keyboard review, which is still required for a defensible audit. JAWS (needs a licence) and VoiceOver (needs Apple hardware) are not run.

## Project structure

The dashboard, API, crawler and NVDA implementation use feature-based ES modules on the existing Node/Express/Playwright stack. There is no new framework installation or build step; `npm start` is unchanged. Read [the architecture and contributor guide](docs/architecture.md) for the request flow, feature ownership, and safe testing workflow.

```text
src/
├── api/
│   ├── app.js               # App factory; composes routes without opening a port
│   ├── routes/              # Health, scans/jobs, reports, compliance, backlog, journeys
│   ├── middleware/          # Local-request security and sanitized API errors
│   └── jobs/lifecycle.js    # Progress, partial/stopped/completed states, public errors
├── browser/
│   ├── session.js           # Browser context, auth state, dialogs, popups
│   └── session-store.js     # DPAPI-encrypted saved sessions
├── scanner/
│   ├── axe.js               # Local deterministic axe evaluation
│   ├── crawler.js           # Stable scanner API (compatibility exports)
│   ├── crawl/               # Run lifecycle, queue, page/state checks, evidence and reporting
│   ├── discovery.js         # Links, modals, Shadow DOM surface notes
│   ├── evidence.js          # Bounding-box screenshot annotation
│   ├── focus.js             # Full keyboard traversal checks
│   ├── adaptation.js        # Zoom, reflow and text-spacing checks
│   ├── media.js             # Captions, audio description, autoplay
│   ├── documents.js         # PDF checks
│   ├── vision.js            # Conditional element-level AI review
│   └── wcag.js              # WCAG registry and VPAT status mapping
├── report/                  # JSON/CSV persistence, VPAT 2.5, backlog, checklists
├── assistive-technology/
│   ├── nvda.js              # Stable NVDA API (compatibility exports)
│   ├── nvda-live.js         # Live session lifecycle and tab ownership
│   ├── nvda/               # Process, keyboard, speech, state runner, recovery and capture
│   └── required-fields.js   # Required-field/asterisk evidence
├── journeys/                # Scripted journey validation and runner
├── mobile/                  # Native Android screen checks
├── cli.js
└── server.js                # npm start entry point; compatibility exports
public/
├── app.js                   # Dashboard wiring, report selection and navigation
├── index.html               # Accessible markup and form IDs
├── styles.css               # Shared presentation
├── dashboard.css            # Dashboard layout
├── features/                # Scan, overview, findings, graph, NVDA, audit, comparison, backlog
├── shared/ui.js             # DOM, formatting and fetch helpers
├── state.js                 # Shared selection and request state
└── demo-report.js           # Clearly labeled illustrative data
journeys/                    # Journey files (test data in journeys/testdata, not committed)
test/                        # Node test suite
scripts/                     # Headless fixtures and explicitly invoked desktop tests
```

## Safety defaults

- `/logout`, `/signout`, `/delete`, and `/remove` routes are excluded by default.
- Modal discovery clicks only explicit dialog triggers such as `aria-haspopup="dialog"`.
- AI is opt-in per scan and unavailable without a configured key.
- Secrets, auth state, dependencies, and generated reports are ignored by Git.
