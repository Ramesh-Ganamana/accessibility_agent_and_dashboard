# Clarity — AI Accessibility Automation Agent

Clarity is a local-first accessibility crawler and reporting dashboard. It uses Playwright and axe-core for the zero-cost baseline, conditionally escalates uncertain image descriptions to a vision model, records issue-highlighted evidence screenshots, and generates JSON plus VPAT/ACR-ready CSV outputs.

## What is implemented

- Secure `.env` configuration and protected `auth_state.json` session persistence.
- Headless Chromium orchestration with configurable selectors for login forms.
- axe-core scanning of documents, open Shadow DOM, and independently addressable frames.
- Same-origin breadth-first crawling, including hash-routed SPAs, with configurable page/depth limits and destructive-route exclusions.
- Browser dialog handling, explicit modal-trigger discovery, `target="_blank"` popup links, and runtime new-window route collection.
- Shared navigation readiness checks wait for DOM content, full load, network settling, visible busy indicators, and a quiet DOM before scanning each page or continuing an authentication step.
- The interactive crawl graph records observed page and dialog states, scanned/failed status, state fingerprints, and labeled navigation or popup actions, including links found inside open Shadow DOM.
- A bounded interaction crawler explores labeled buttons, tabs, menu items, JavaScript-driven role controls, and clickable `div`/`span` containers. It restores and replays state paths, waits after each action, and uses the UI State limit plus Depth settings to control coverage.
- The State limit is the maximum combined page/interaction-state budget, not the number of controls discovered. Depth is the maximum action-chain length. Reports record discovered candidates, attempted actions, observed states, routes, and restoration failures so bounded coverage is explicit.
- The optional **Do not click in this application** field accepts comma-separated exact accessible labels. Each rule is scoped to the current Application URL origin and applies to deterministic and numbered-AI action selection only on that application, without hardcoding a provider into the crawler.
- When Conditional Vision AI is enabled and deterministic crawling produces no new route or UI state for 50 seconds, a numbered-DOM fallback deduplicates visible semantic elements (including text, labels, inputs, containers, and open Shadow DOM), draws number badges, sends a numbered viewport screenshot plus sanitized metadata through the Responses API, validates the structured numeric choice, and invokes the selected live element with JavaScript. Unsafe, destructive, registration, credential, payment, logout, and form-mutation actions remain blocked.
- Destructive actions, form submissions, mutating form roles, disabled controls, and unlabeled controls are excluded from automatic clicking.
- Navigation uses a resilient commit-plus-readiness strategy so slow SPAs that delay `DOMContentLoaded` do not terminate the crawl. Generic loading screens are awaited, and an interaction-triggered sign-in gate reuses the credentials supplied for that scan.
- Authentication entry screens with a Sign in context and a generic Continue control are handled before searching the redirected identity-provider page for email and password fields.
- After authentication, this handler remains dormant unless a visible blocking dialog, modal, or popover actually appears. Inside that obstruction, domain, tenant, workspace, organization, company, or client choosers can be completed with the optional value supplied in the scan form (for example, `JCB`). Exact visible matches are selected, and ordinary Close, Dismiss, Not now, Skip, Cancel, X, or × controls can be used to clear non-security dialogs.
- The scan form displays live phase, progress, elapsed time, current URL, recent steps, recoverable warnings, and a focused failure alert with retry guidance when a scan stops.
- Page readiness is driven by visible, meaningful application content. A full-page blocking loader waits, while a usable form or dashboard proceeds even if a small spinner or progress widget remains.
- One-time OAuth/OIDC callback URLs containing authorization `code` and `state` values are never reloaded to discover controls. The already-rendered authenticated state is inventoried first, and transient navigation is retried before declaring that no controls exist.
- Interaction crawling no longer performs a final page reload after its work is complete. Required state restoration reuses the already-open root state when possible, waits for a competing OAuth redirect to settle, and removes authorization values from diagnostic messages. Evidence is discarded if the underlying document changes before its screenshot is captured.
- If a protected application state cannot be reconstructed safely, the crawler tries dismissing transient UI and browser-history recovery for both SPA and MPA navigation. A remaining failure skips only that branch after 50 seconds, records a coverage warning, and continues instead of aborting the entire page.
- Keyboard Tab traversal with focus-indicator review against WCAG 2.4.7.
- Optional, element-cropped vision review of images that already contain custom alt text.
- Per-finding screenshots with a red bounding box and WCAG/rule label drawn over the affected element.
- Needs-review findings are listed beside confirmed issues, include highlighted evidence when the element remains stable, fall back to a clearly labeled page-context image when necessary, and retain a review-history entry explaining why human judgment is required.
- Interactive crawl graph connecting pages, links, and popup routes.
- WCAG registry mapping and automatic `Supports`, `Partially Supports`, or `Does Not Support` draft language.
- `vpat_draft.json` and `ACR_VPAT_Report.csv` for every completed run.

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
```

## Authentication

For different applications, enable **Website requires login** in the dashboard and enter the login-page URL, username, and masked password. These values are sent only to the local server for that scan and are not stored in reports. When **Remember the authenticated session** is enabled, only the resulting cookies and local storage are saved in the git-ignored `auth_state.json` file.

The advanced section in the UI accepts application-specific username, password, and submit-button selectors when a login page does not use standard HTML fields.

Username-first providers such as Azure B2C are supported: the agent fills the username, activates Continue/Next, waits through redirects and frames, then fills the password stage.

If the application displays a required domain, tenant, workspace, organization, company, or client chooser after login, enter its exact value in **Domain / tenant / workspace** before starting the scan. If the value is omitted, the scan stops at that chooser with an instruction to enter it and retry. Ordinary post-login notices may be closed automatically; CAPTCHA, MFA, consent, permissions, passkeys, and other security prompts are never dismissed automatically.

The configured authentication URL may be either a direct login page or an application landing page. On landing pages, the agent discovers safe authentication-entry controls such as Log in, Sign in, My account, and identity-provider buttons before locating the credential fields. It intentionally does not click arbitrary DOM actions because unrelated buttons can have destructive business effects.

When `OPENAI_API_KEY` is configured, the dashboard can enable an AI-assisted fallback for unfamiliar login DOMs. It uses the Responses API with structured JSON output and sends only sanitized control metadata such as labels, roles, element types, and placeholders. Usernames, passwords, field values, cookies, tokens, and storage state are excluded. API responses use `store: false`.

The agent does not bypass CAPTCHA, MFA/OTP, passkeys, security keys, biometric checks, or device approval. These controls intentionally require user action; the scan stops with an actionable message instead of weakening the authentication boundary.

Environment variables (`LOGIN_URL`, `LOGIN_EMAIL`, and `LOGIN_PASSWORD`) remain available for unattended CLI scans, but they are not required for dashboard scans.

For SSO, MFA, CAPTCHA, or passkey flows, create `auth_state.json` using an approved interactive login process. Do not attempt to bypass those controls.

## Vision AI cost control

Vision review is disabled unless both conditions are true:

1. `OPENAI_API_KEY` is present.
2. “Conditional vision AI” is enabled for the scan.

The alt-quality path sends only cropped visible `img` elements with non-empty custom alt text. The stalled-crawl numbered-element path sends one numbered viewport screenshot plus sanitized DOM metadata after 50 seconds without progress. Passwords, input values, cookies, storage, tokens, and hidden elements are excluded; visible page content in the screenshot is necessarily included. API responses use `store: false`.

## Reports

Each run creates:

```text
reports/<run-id>/
├── vpat_draft.json
├── ACR_VPAT_Report.csv
└── evidence/
    ├── baselines/
    └── <finding screenshots>.png
```

The JSON file is the canonical report. The CSV is a review draft, not a legal declaration of conformance.

The dashboard opens the latest completed report on load. Use **Saved reports** to inspect a different execution, or press **Compare reports** to enter a separate comparison workspace. There, choose any two completed scans in either order and press **Compare**; the agent determines which is earlier. Once one report is chosen, reports from other hostnames are disabled; the API also rejects cross-site comparisons. The delta grid groups confirmed WCAG findings by criterion, rule, page/state, and element path into new, fixed, and unresolved categories. Select a finding or its **View screenshots** button to inspect saved visual evidence from the earlier and later scans side by side. New issues use their later highlighted capture, fixed issues use their earlier highlighted capture, and unresolved issues can show both. A saved page baseline may supply context on the other side, but is explicitly labeled as context rather than evidence of a pass; missing captures are labeled rather than fabricated. The comparison workspace shows two independently labeled crawl graphs—one from each execution—without altering the single-report graph. Findings on pages or states not scanned in both runs, or with an uncertain counterpart, are excluded from new/fixed claims and counted in the comparison note. An absent finding is not proof of a WCAG pass.

## Dashboard assessment and API

The dashboard shows an **observed accessibility health** score from 0–10 and a provisional grade (A+ through F). Confirmed findings are weighted by impact and normalized by observed states; findings that need review do not count as proven failures. The score card separately shows scan coverage and confidence. It is a heuristic for prioritizing work, **not** a WCAG conformance certification or proof that unobserved routes pass.

The original `GET /api/reports/:id` JSON remains intact. Read-only dashboard endpoints are `GET /api/reports/:id/overview`, `/score`, `/issues`, `/pages`, `/graph`, `/activity`, `/acr`, and `/evidence`. Evidence entries include local image URLs when the saved path is valid. The existing `GET /api/reports/:id/compare/:previousId` endpoint remains the separate, same-application comparison view.

## Application coverage and honest limits

The scanner is designed for traditional sites, SPAs, server-rendered applications, open Shadow DOM web components, dialogs present in or explicitly opened from the DOM, same-session popups, and frames Playwright can address.

No generic scanner can inspect closed Shadow DOM internals because their owning component intentionally does not expose them. Cross-origin frames, anti-automation challenges, native browser chrome, canvas-only interfaces, and states behind unknown business workflows can also require application-specific adapters. Clarity records these limitations instead of treating inaccessible surfaces as passes. Manual screen-reader, zoom, reflow, cognitive, and keyboard review is still required for a defensible audit.

## Project structure

```text
src/
├── browser/session.js       # Browser context, auth state, dialogs, popups
├── scanner/
│   ├── axe.js               # Local deterministic axe evaluation
│   ├── crawler.js           # Crawl/scan orchestration
│   ├── discovery.js         # Links, modals, Shadow DOM surface notes
│   ├── evidence.js          # Bounding-box screenshot annotation
│   ├── focus.js             # Sequential keyboard traversal
│   ├── vision.js            # Conditional element-level AI review
│   └── wcag.js              # WCAG registry and VPAT status mapping
├── report/                  # JSON/CSV persistence
├── cli.js
└── server.js
public/                      # Accessible reporting dashboard + crawl graph
test/                        # Node test suite
```

## Safety defaults

- `/logout`, `/signout`, `/delete`, and `/remove` routes are excluded by default.
- Modal discovery clicks only explicit dialog triggers such as `aria-haspopup="dialog"`.
- AI is opt-in per scan and unavailable without a configured key.
- Secrets, auth state, dependencies, and generated reports are ignored by Git.
