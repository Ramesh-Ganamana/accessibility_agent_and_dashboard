# Accessibility Agent: dashboard options and purpose

Updated: 28 October 2026. Based on the current dashboard and its implementation, not the older screenshots or presentation roadmap.

This guide explains every user-facing dashboard control: what it does, why it exists, and when to use it. It also explains the result indicators. Developer-only configuration is not a dashboard option; a short NVDA configuration reference is included separately.

The agent helps discover accessibility defects, collect evidence, run bounded NVDA checks, and prepare material for human review. It does **not** automatically establish complete WCAG compliance, SEBI compliance, auditor qualifications, or accessibility for every user.

## Contents

1. [A practical first run](#1-a-practical-first-run)
2. [Navigation and report selection](#2-navigation-and-report-selection)
3. [New scan: scope and coverage](#3-new-scan-scope-and-coverage)
4. [AI and NVDA options](#4-ai-and-nvda-options)
5. [Do not click in this application](#5-do-not-click-in-this-application)
6. [Login options](#6-login-options)
7. [Scripted journeys](#7-scripted-journeys)
8. [Progress and overview](#8-progress-and-overview)
9. [Issues and visual evidence](#9-issues-and-visual-evidence)
10. [Crawl graph](#10-crawl-graph)
11. [Screen-reader readiness and NVDA results](#11-screen-reader-readiness-and-nvda-results)
12. [VPAT / ACR and human review](#12-vpat--acr-and-human-review)
13. [Regulatory checklists](#13-regulatory-checklists)
14. [Financial evidence workbook](#14-financial-evidence-workbook)
15. [Remediation backlog](#15-remediation-backlog)
16. [Compare reports](#16-compare-reports)
17. [Downloads and exports](#17-downloads-and-exports)
18. [Common questions and limitations](#18-common-questions-and-limitations)
19. [Where these options live in the code](#19-where-these-options-live-in-the-code)

## 1. A practical first run

1. Use a website you are authorized to test, preferably staging with a dedicated test account. Automatic safety rules reduce risk but cannot guarantee that an arbitrary website has no side effects.
2. Start the dashboard using `npm start` in the project folder. Keep that terminal open and use the localhost address it prints.
3. Select **New scan** and enter the application URL.
4. For a small initial check, use Page limit **1**, State limit **10**, Depth **2**, General web application, WCAG 2.2 A + AA, and Desktop. These are example settings, not a full-audit scope.
5. Add any actions you must not activate under **Do not click in this application**. Verify the parsed-entry summary below the field.
6. Enable login only if needed. Leave advanced selectors blank initially.
7. Leave Conditional vision AI off unless sending permitted page content to the configured AI service is approved. Enable NVDA only when its prerequisites are ready and the desktop is dedicated to the test.
8. Press **Start scan**. Review progress, coverage gaps, findings, and NVDA outcomes; do not judge the run only by its score.
9. Assign fixes, perform the required human checks, rerun the affected scope, and export the reviewed material.

Changing options or opening **New scan** does not start a test. **Start scan** and **Run journey** do. Closing the dashboard tab is not a stop command for the backend. The current dashboard has no dedicated Stop scan button. Do not close the server during a scan unless you intend to interrupt it.

## 2. Navigation and report selection

| Option | What it does and why it is there | When to use / important detail |
| --- | --- | --- |
| New scan / + New scan | Moves to the scan form and focuses the URL field. | Configure another run. It does not erase reports, reset every field, or start scanning by itself. |
| RAMBO home / logo | Opens the dashboard root. | Return to the application entry point. This reloads the page; unsaved form edits may be lost. |
| Skip to main content | Lets keyboard users bypass repeated navigation. | Use it to reach the main workspace quickly. |
| Overview | Opens the current report's summary. | Review observed risk and coverage before inspecting individual issues. |
| Issues & evidence / Issues | Opens findings and their supporting evidence. | Investigate defects and choose work for remediation. |
| Crawl graph | Shows the routes and interaction states observed. | Understand what was reached, linked, skipped, or failed. |
| Screen readers / Screen-reader readiness | Opens browser-tree inspection and any recorded real NVDA run. | Distinguish structural observations from actual screen-reader execution. |
| VPAT / ACR | Opens the review matrix, product details, checklists, and exports. | Prepare evidence-backed reporting; human decisions are still required. |
| Remediation | Opens fix tracking for the report's website. | Assign, update, and verify work across scans. |
| Compare reports | Opens a separate two-report comparison workspace. | Assess changes between completed runs of the same hostname. |
| Toggle color theme | Switches dashboard light/dark appearance. | Personal viewing preference only; it does not change the tested website or scan method. |
| Saved reports | Loads a selected saved execution. | Inspect earlier runs, including partial runs identified by status. This does not rerun a scan. |

The dashboard initially has an illustrative demo and attempts to load a saved completed report. **Demo audit / Interactive sample** is not evidence that your application was tested. Downloads and review operations need a real saved report.

## 3. New scan: scope and coverage

These are the form's initial defaults, not a claim about a previously submitted run or customized server configuration.

| Option | Default / accepted choices | Purpose and how to choose |
| --- | --- | --- |
| Application URL | Required HTTP or HTTPS address | The starting website/page and the basis for application scope. Enter the page you intend to audit, not the localhost dashboard URL. Use a complete address such as `https://app.example.com/`. |
| Page limit | 10; range 1–100 | Caps distinct page URLs. It limits time and navigation breadth. Set 1 for the starting page with its same-page interactions; increase it to explore more routes. |
| State limit | 100; range 1–500 | Caps combined page and interaction states. A menu opening, dialog appearing, or tab changing can be another state at the same URL. Increase it for more reachable interaction coverage, accepting longer runs. |
| Depth | 2; range 0–8 | Caps the chain of navigation/actions from the starting state. Depth 0 inspects only the starting state. A larger state limit alone cannot overcome a shallow depth limit. |
| Application profile | General web application / Financial web application | Both use the same underlying web scanner. Financial adds domain-specific review prompts and an evidence workbook. It does not automatically execute banking/trading processes or certify a financial application. |
| Audit standard | WCAG 2.2 A + AA / WCAG 2.1 A + AA; initially 2.2 | Selects the standard/version for the audit scope and review matrix. AA includes A. A complete matrix is not proof that every criterion has been tested or passed. |
| Viewport | Desktop (1440 × 960) / Mobile (Pixel 7 emulation, touch); initially Desktop | Exercises a desktop or responsive mobile website layout. Mobile is Chromium emulation, not a real Android/iOS device or TalkBack/VoiceOver test. Actual NVDA requires Desktop; the API rejects Mobile + NVDA. The NVDA desktop browser is maximized, so its viewport may follow the actual window. |
| Start scan | Submit button | Sends the selected configuration to the local backend and begins the scan. It checks backend connectivity first and shows progress. Use only after reviewing scope, exclusions, login, AI, and NVDA choices. |

### Why page, state, and depth are separate

Imagine one dashboard URL with a closed menu, an open menu, and an open help dialog. That can be **one page with several states**. A link to `/statements` adds a different page. Opening a menu and then a submenu requires more action depth than opening the menu alone.

These are maximum budgets, not targets. A run may discover fewer states than requested, and separate time/safety/NVDA limits can also stop exploration. Raising the limits does not guarantee that every screen, record, role, or business journey is reached.

## 4. AI and NVDA options

| Option | Purpose / benefit | Requirements, cost, and limits |
| --- | --- | --- |
| Conditional vision AI | Adds optional image-description review and a numbered-element fallback when deterministic crawling makes no progress. | Off initially. Requires configured API access. Calls can incur the provider's usage charges. Cropped images or numbered viewport screenshots and sanitized metadata may leave the machine; visible sensitive content can still appear in screenshots. Leave off when that transfer is not permitted. AI must still obey action restrictions. |
| Run actual NVDA during the headed crawl | Adds observed screen-reader speech and keyboard evidence for states while the crawler is still on them. This can expose behavior that a browser accessibility-tree preview alone cannot establish. | Off until selected and disabled when prerequisites are unavailable. Needs Windows, installed NVDA, the dedicated capture add-on/profile, enabled server configuration, and an interactive desktop. More checks and audible reading increase runtime. It is not a guarantee that all accessibility issues will be captured. |
| NVDA availability message | Explains whether the option can be enabled and why it is unavailable. | Read the actual reason: missing executable, disabled configuration, missing/outdated add-on, helper problem, or unavailable backend. “Available” means configuration was detected, not that a live test has succeeded. |

The normal NVDA sequence is: launch the visible browser with NVDA preparation, inspect a state, perform its NVDA checks, then continue crawling. Startup includes process/add-on/focus checks, so zero startup latency is not guaranteed.

If the label instead says **Run actual NVDA after the crawl (replay mode)**, the server has explicitly selected the alternative replay workflow. It attempts to recreate states after crawling. A state that cannot be reproduced is not treated as tested.

NVDA needs the test browser/tab to have the correct desktop focus. The integration scopes its capture and guards keyboard commands; it does not turn NVDA into a background reader that can independently operate an unfocused tab while you use other applications. Leave the desktop idle. Focus departures can cause pauses, recovery attempts, or an interrupted test. Closing the owned test tab ends that scope and triggers cleanup; an independently started NVDA process is not owned by the agent.

### Advanced NVDA configuration reference — not dashboard controls

For an administrator changing the existing `.env` configuration, the following settings explain the most common differences between runs. They are code defaults, not a reading of your private `.env`. Restart the server at a safe time after changing configuration.

| Setting | Code default / purpose |
| --- | --- |
| `NVDA_ENABLED` | `false`; permits the optional integration. The dashboard run must also request it. |
| `NVDA_PATH` | Optional explicit path to the installed `nvda.exe`; otherwise standard installation paths are checked. This must not point to the downloaded installer. |
| `NVDA_CONFIG_PATH` | Dedicated profile, normally under `%LOCALAPPDATA%\RAMBO\nvda-profile`; holds the capture add-on and agent settings. |
| `NVDA_MODE` | `during-crawl`; `after-crawl` explicitly selects replay. |
| `NVDA_MAX_STATES` | 100; an independent NVDA state cap. Raising the crawl State limit alone does not raise this cap. |
| `NVDA_TESTS` | `focus,reading,headings,tables`; selects supported test groups. Results show what actually ran. |
| `NVDA_TAB_STOPS` | 12; bounds sampled focus stops, not the number of all website controls. |
| `NVDA_HEADING_STOPS` / `NVDA_TABLE_STOPS` | 3 each; bounded heading/table navigation samples. |
| `NVDA_READING_TIMEOUT_MS` | 300000 (5 minutes); bounds a reading check. A timeout/unconfirmed completion must not be interpreted as read-to-end success. |
| `NVDA_SPEECH_RATE` | 40 on NVDA's 0–100 rate scale; lower values are slower. This is not words per minute. |
| `NVDA_FAST_SPEECH` | `false`; accelerated capture is opt-in, not the normal listening experience. |
| `NVDA_ACTION_SCREENSHOTS` | `review`; saves per-action captures for review cases. `all` requests every stop and uses more storage. |

This is not an exhaustive `.env` reference. See [README](../README.md) and [configuration code](../src/config.js) for other bounded timeouts and safety settings.

## 5. Do not click in this application

Purpose: tell the agent which controls or destinations it must not activate. It is an exclusion list, **not an AI prompt**. Multiple entries apply together; matching is not limited to the first item or the first matching element.

Use one entry per line for clarity. Commas also separate entries. Quote an entry containing a literal comma, such as `"No, thanks"`.

| What you want to exclude | Example entry | Why it works / caution |
| --- | --- | --- |
| A named button or link | `Deactivate my account` | Matches text/accessible naming metadata. Every matching control is excluded. |
| A word or phrase in a label | `Pay` | Whole-word/phrase matching can block “Pay now” without matching “Payroll.” Broad terms can block more actions than intended. |
| An image link with alternative text | `Medica` | Uses the image's alt/ARIA naming metadata, including nested images within clickable controls. Use the actual metadata, not a guessed visual description. |
| An image file | `kp_desktop_icon.png` | Matches supported image-source metadata. Useful when an image label is absent or misleading. |
| A control attribute | `data-testid=deactivate-account` | Targets an attribute/value rather than the displayed label. Use the value present in the application. |
| A CSS selector | `#delete-account` or `button.danger` | Targets elements matching that selector. Ask a UI engineer for a stable selector if necessary; generated classes can change. |
| A destination or image URL/path | `/provider` or `https://app.example.com/provider` | Excludes matching navigation/image destinations within application scope. URL paths/query values retain their relevant case-sensitive behavior. |

Example with two buttons and one image:

```text
Deactivate my account
Submit payment
Medica
```

Read the summary below the field before starting. It shows parsed entries and any additional server-configured exclusions. Repeating the same entry is unnecessary.

Important boundaries:

- Text matching ignores case and extra whitespace. Descriptions such as “the red image at the top” are not visual targeting instructions. Regex is not an input language for this field.
- Up to 100 merged entries are allowed, each at most 2048 characters. Excess input is rejected, not silently shortened. Server `EXCLUDE_ACTION_LABELS` entries also count and remain active.
- The policy applies within the application's scope, including supported www/HTTPS variants and adopted application origins. It is not a laptop-wide rule for unrelated sites/apps.
- Exclusions apply to crawler discovery/activation, AI candidates, replay, relevant login/context actions, and journeys launched below. If you exclude a necessary login button or dialog dismissal, the run can be blocked; the agent should not silently override you.
- An excluded element may still appear in accessibility findings. “Do not click” does not mean “do not inspect.”
- The guard does not prevent a site's own scripts, timers, redirects, or background requests. Use an authorized test environment and review coverage warnings; this is not a transaction-safety guarantee.

## 6. Login options

| Option | Purpose and why it exists | What to enter / important detail |
| --- | --- | --- |
| Website requires login | Enables the authenticated-scan settings. | Turn on for protected screens. Leave off for a public-only run. |
| Application or login-entry URL | Identifies where authentication begins, which may differ from the page to audit. | Enter a complete HTTP/HTTPS URL. Although the placeholder mentions `/login`, the current API expects an absolute URL. |
| Username or email | Supplies the test account identity to automatic login discovery. | Use an authorized test account, not a real customer's account. |
| Password | Supplies the local login secret. | The dashboard masks it and clears the input after sending the scan request. Do not put credentials into notes, exports, or evidence references. |
| Domain / tenant / workspace | Selects the intended organization/context when the application requires one. | Optional unless the application presents such a chooser. Use the exact visible value; it is not a free-form instruction to fill other forms. |
| Remember the authenticated session on this computer | Reuses resulting cookies/local storage on later runs, reducing repeated login. | Checked initially. Windows sessions are stored outside the repository and protected for the current Windows user. They still grant access and must be protected. Unchecking avoids saving this run's session; it is not a delete-existing-sessions command. |
| AI-assisted fallback for unfamiliar login forms | Uses sanitized control metadata to help identify an unfamiliar login UI when normal discovery is insufficient. | Separate from Conditional vision AI. Enabled/checked by the UI when configured API access is detected; review it before submitting. Credentials and input values are excluded from the model payload, but API usage can incur cost. |
| Advanced login selectors | Reveals optional technical overrides for login controls. | Leave blank initially. Automatic discovery is the default; these are not normally required. |
| Username selector | Overrides discovery of the username field. | Example: `input[name="username"]`. Use only a verified selector. |
| Password selector | Overrides discovery of the password field. | Example: `input[type="password"]`. It must target the correct masked password input. |
| Submit selector | Overrides discovery of the login submit/continue button. | Example: `button[type="submit"]`. Avoid a broad selector that also matches registration or another form. |

The agent does not bypass OTP/MFA, CAPTCHA, passkeys, consent/security boundaries, or device approval. These can require an approved interactive login/session preparation or leave the scan blocked. “Failed to fetch” is a backend/connectivity error, not proof that login selectors are missing.

## 7. Scripted journeys

Purpose: repeat a deliberately authored workflow when ordinary discovery is not enough. This is distinct from the financial workbook, which records human tests rather than executing them.

| Option | Purpose / use |
| --- | --- |
| Journey | Selects a validated JSON journey from the project's `journeys` folder. The list shows its name, declared environment, and step count. Invalid files are disabled; an empty list means no usable file was found. |
| Run journey | Executes that file's declared steps and scans its checkpoints. It uses the journey definition/local test data, not all of the New scan form's settings. Do not assume the form's URL, credentials, limits, or NVDA toggle are inherited. The Do not click entries are explicitly carried over. |
| Journey status message | Explains validation/start errors or points to the progress panel. |

Journey files restrict allowed websites and require consequential steps to be explicitly marked and limited to sandbox/staging. This is not permission to transact. Use synthetic data and an approved test plan. The example file is a template, not a ready-made test of your application.

## 8. Progress and overview

These indicators explain the observed run; they are not additional scan configuration.

| Display / option | Purpose and correct interpretation |
| --- | --- |
| Phase, current activity, URL, elapsed time, recent steps | Shows what the backend is doing and helps diagnose a stall or failure. An interaction-state message can describe a menu or dialog at the same URL, not a new page. |
| Progress percentage | Workflow progress, not the percentage of all website content tested. Reaching completion means the bounded run ended, not that the whole site passed. |
| Warnings / failure message | Explains skipped work, unsafe actions, restoration problems, or connection loss. Read before retrying; a lost response can mean the first scan is already running. |
| Accessibility health score and grade | A heuristic based on observed confirmed findings, weighted by impact and normalized by scanned pages. Useful for prioritization, not a WCAG conformance percentage. |
| How is this score calculated? | Expands the methodology and caveats. Use it before presenting a score to management or comparing differently scoped runs. |
| States observed / confidence / need review | Separates coverage and uncertainty from the score. More observed states do not automatically mean higher accessibility or complete coverage. |
| Four principles | Groups observed results into accessibility principles to help focus review. It is not four independent certifications. |
| Confirmed issues | Automated findings mapped to WCAG. Confirmation of an observed defect is not a full criterion/site assessment. |
| Needs review | Cases automation could not conclusively decide. They need investigation, not automatic dismissal or conversion to a pass. |
| Evidence captures | Shows saved visual support for findings. A screenshot alone does not prove keyboard or screen-reader behavior. |
| Audit duration / AI escalations | Shows elapsed work and recorded AI use; AI escalations are not a currency bill. |
| Issue severity / Application surfaces / What the agent inspected | Shows risk distribution, observed surfaces, and scan activity. Helps identify coverage gaps before accepting the report. |

## 9. Issues and visual evidence

| Option | Purpose / use |
| --- | --- |
| Filter by rule, page, or selector | Searches finding titles/rule IDs, page URLs, and DOM targets. Use it to locate a component or defect quickly. |
| All impacts / Critical / Serious / Moderate / Minor | Narrows by automated impact rating. Impact is not the WCAG level A/AA and does not establish a legal priority by itself. |
| Confirmed + needs review | Default list of confirmed and uncertain findings; does not include the separate best-practice group. |
| Confirmed only | Shows automated WCAG-mapped defects for triage. |
| Needs review only | Shows uncertain observations requiring human judgment. |
| Best practice only (not scored) | Shows useful non-WCAG-mapped recommendations without counting them as confirmed WCAG failures. |
| Finding row | Selects the finding and displays its screenshot, criterion mapping, observed state, source, target, and explanation. |
| Add to remediation backlog | Tracks the selected finding for assignment and retesting. It does not repair the website or resolve the finding. |
| Finding review history | Explains recorded review context, especially why a case needs human judgment. |

All active filters combine, including any page/state selected in the crawl graph. If the list looks empty, clear search/impact/status restrictions and clear the selected graph node.

Evidence can be element-highlighted, page context only, or captured under a test condition such as a narrow viewport/text spacing. Read its caption. A context image is not element-level proof. No saved screenshot means missing evidence, not successful testing.

## 10. Crawl graph

| Option / display | Purpose / use |
| --- | --- |
| State/page node | Select it with a click or Enter/Space to open related findings. Select the same node again in the graph to clear that selection. |
| Directed arrow and label | Shows the recorded navigation/action relationship. Helps explain how the crawler reached a state. |
| Scanned / Failed / Popup legend | Distinguishes execution state and transition type. “Scanned” does not mean “no accessibility issues.” |
| Coverage note | Describes limits or gaps in the observed crawl. A graph is not a guaranteed inventory of the whole application. |
| New tabs opened during the crawl | Shows child-tab coverage, including tested-in-place versus not-tested outcomes and reasons. This helps avoid treating an opened tab as an audited tab. |

For supported in-scope child tabs, the crawler attempts to inspect them and return to the original tab/state. Restrictions, closed tabs, and failed restoration can leave gaps. The graph/report outcome, not the mere existence of a tab, is the evidence of coverage.

## 11. Screen-reader readiness and NVDA results

There are two different evidence sources on this screen. Do not combine them into a claim of complete screen-reader testing.

### Browser accessibility-tree inspection

| Option / display | Purpose / use |
| --- | --- |
| Tree states inspected | Counts saved accessibility-tree snapshots, including relevant frame/state entries. It need not equal the number of distinct URLs or actual NVDA states. |
| Review warnings | Counts structural warnings from those snapshots. Zero warnings is not proof of usability or conformance. |
| Page and interaction state | Chooses the snapshot to inspect; a frame may be listed separately. |
| What needs attention | Lists warnings or explains that human screen-reader review is still needed. |
| Approximate announcement sequence | Displays roles, names, descriptions, values, and states exposed by Chromium. It is a preview, not recorded NVDA audio/transcript. |

### Actual NVDA execution

| Option / display | Purpose / use |
| --- | --- |
| NVDA / JAWS / VoiceOver / TalkBack cards | Shows recorded product execution status. NVDA is the integrated desktop runner here. The other product names do not mean those products were run. |
| NVDA version | Identifies the reader version recorded for the run. A version alone is not proof of successful testing. |
| States tested / attempted | Separates states with execution evidence from attempted work. Read notes for selected, discovered, skipped, and interrupted states. |
| Keyboard commands | Counts recorded commands, not every control on the site. |
| Announcements captured | Counts captured speech events; not issue count and not proof that all text was read. |
| Tested state | Selects a state to review its actions, transcripts, checks, and evidence. Older reports may show Legacy tested page instead. |
| Focus / Reading / Headings / Tables check cards | Shows outcomes for configured test groups. Reading attempts available browse content with a time limit; heading/table/focus tests are bounded samples. |
| Required fields check | Reports whether applicable focused fields have required indicators and a corresponding captured announcement. Native `required`, `aria-required`, explicit labeling, and supported associated star/instruction patterns can provide evidence. An unexplained `*` alone is not a reliable “required” declaration; ambiguity needs review. The check does not add missing required-field semantics or invent speech. |
| Command and transcript row | Shows the command, captured announcement, available focus metadata, and state-change/reading-completion observations. Use it to investigate actual behavior. |
| Scope and review notes | Explains incomplete reading, focus departures, recovery, blocked states, and other limitations. These notes are part of the result, not optional footnotes. |
| Open headed-browser evidence screenshot / command screenshot | Opens a saved capture for that state/action. These links need the local server and saved files. No screenshot link is a guarantee of recorded audio. |

### What the statuses mean

| Status | Meaning |
| --- | --- |
| Not run | No product execution was recorded for this report. Do not interpret as pass or fail. |
| Blocked | A prerequisite/scope/execution condition prevented valid test evidence. Read the reason; it is not automatically an accessibility failure in the website. Hearing NVDA speak somewhere on the desktop does not establish an attributed website test. |
| Executed / Completed | The indicated execution/work completed within its recorded scope. It is not equivalent to WCAG conformance or all-user-journey success. |
| Interrupted / Partially tested | Some work started but did not finish. Retained evidence is useful; unfinished checks remain untested. |
| Needs review / incomplete reading | Human investigation or a retest is required. Speech captured is not always confirmed read-to-end completion. |

NVDA results supplement automated checks; they do not replace experienced user testing of complete tasks. This dashboard does not provide an “all languages” guarantee. Language behavior depends on content metadata, installed voices, and reader configuration; the website also needs correct semantics and readable alternatives.

## 12. VPAT / ACR and human review

A VPAT is a reporting template; the completed report is an Accessibility Conformance Report (ACR). Here, automated evidence feeds a working draft. Rows without documented decisions remain **Not Evaluated**. A generated file, completed review count, or removed draft label is not independent certification.

### Review matrix and product details

| Option | Purpose / what to enter |
| --- | --- |
| Scope and limitations | Expands what was tested, methods, and exclusions. Read it before making any conformance decision. |
| Product name | Identifies the evaluated application in the export. |
| Product version | Identifies the actual build/release; prevents evidence being attributed to an untested release. |
| Report date | Identifies the report's stated date; does not change when the scan actually occurred. |
| Contact information | Gives readers an accessibility contact email or URL. |
| Product description | Describes what the product does and the relevant scope. |
| Evaluation methods used | Describes methods actually performed. Leave blank to use recorded methods; do not list JAWS, user testing, or journeys that were not performed. |
| Notes | Records contextual caveats or exclusions for the exported report. |
| Save product details | Persists these details for this report's subsequent exports. It does not rerun or alter observed findings. |
| Edition | Chooses WCAG, Revised Section 508, EU (EN 301 549), or International output structure. Selecting an edition adds reporting obligations/rows; it does not perform new tests. |
| Section 508 and EN 301 549 rows | Expands those additional rows and pending decisions. Use Record decision where appropriate, including justified non-applicability. |
| Record review / Record decision | Opens the evidence-backed decision form for that criterion, additional row, manual check, or regulatory item. |
| Required human review | Lists checks requiring actual human evaluation. A manual-check pass does not automatically set associated WCAG criteria to Supports. |
| Review history | Shows appended decisions, authors as entered, scope, rationale, and evidence references. Earlier entries and original scan evidence are retained. |

### Review entry fields

| Field / button | Why it is there |
| --- | --- |
| Decision | Records the outcome appropriate to the selected item. Choose a documented result, not a preferred report appearance. |
| Reviewer | Identifies who made the decision. The app records the entered name; it does not verify identity or qualifications. |
| Tested scope and environment | Records build, pages/states, journey, browser, OS, assistive technology, and exclusions so the decision has a defensible boundary. |
| Findings and rationale | Explains what was observed and why the decision follows. |
| Evidence references — one per line | Links the decision to controlled test records, paths, or URLs. This is a reference field, not an evidence-upload or evidence-authenticity check. Do not include secrets or customer data. |
| Save review entry | Appends the review and refreshes the report. It does not repair the application. |
| Cancel | Hides the review form without saving that entry. |

Decision choices depend on the item:

| Item | Available decisions and interpretation |
| --- | --- |
| WCAG criterion / VPAT row | Supports, Partially Supports, Does Not Support, Not Applicable. These require a scoped human assessment. For WCAG criteria with unresolved confirmed findings, contradictory Supports/Not Applicable choices are disabled. |
| Required human check | Pass, Fail, Not Applicable. Describes that check only. |
| Regulatory checklist item | Met, Partially met, Not met, Not applicable. Describes the documented item assessment, not automatic regulator approval. |
| Financial scenario step | Pass, Fail, Blocked, Not applicable. Blocked means testing was prevented, not successful. |

Use a new scan/retest and the established review process after remediation; do not relabel an old observed failure as a successful retest.

## 13. Regulatory checklists

Purpose: organize evidence for requirements beyond automated WCAG findings. Built-in checklists contain public-source summaries; a compliance owner must verify applicability and current authoritative requirements. This guide explains the software, not legal obligations.

| Option | Purpose / use |
| --- | --- |
| Checklist | Selects an available built-in or imported checklist, such as GIGW/SEBI review material. |
| Requirement / related WCAG results | Displays the requirement and relevant findings/decisions as reference. Related WCAG observations do not automatically decide the requirement. |
| Open source | Opens the recorded source link for reviewer verification. |
| Record decision | Records a human decision using the shared review form. |
| Download checklist CSV | Exports the report's checklist material and decisions. The current endpoint exports the report's checklist collection, not only the selected dropdown view. |
| Import a checklist | Opens the form for an organization-supplied checklist, including content you are authorized to use. It does not acquire a standards licence or validate the imported requirements. |
| Checklist id | Supplies a stable identifier, for example `internal-accessibility`. |
| Title | Gives the imported checklist a human-readable name. |
| CSV | Supplies a header with `reference,requirement`; optional columns are `title,category,wcag,verification,source`. Use semicolons between multiple WCAG references. |
| Import checklist | Saves the imported set into the local checklist catalog. Imported requirements still need report-specific reviewer decisions. |

Example CSV shape, using an illustrative internal requirement rather than reproducing a licensed standard:

```csv
reference,requirement,title,wcag
INTERNAL-01,Verify the help link is usable with a keyboard,Help navigation,2.1.1
```

## 14. Financial evidence workbook

Shown for the Financial web application profile. It provides 32 guided steps across eight groups: onboarding/KYC, authentication, portfolio/market data, trading/orders, payments/withdrawals, statements/disclosures, help/complaints, and account settings.

| Option / display | Purpose / use |
| --- | --- |
| Journey heading | Expands prerequisites, instructions, expected outcomes, related criteria, and evidence guidance. It does not execute the journey. |
| What remains before this workbook is reviewed | Shows pending/blocked/inconsistent review conditions. “No workbook blockers” still does not mean the application is compliant. |
| Record scenario review | Opens the common review form plus a financial execution record. Record what was actually tested. |
| Test environment | Choose Sandbox, Staging, or Production — read-only observation. Consequential scenarios require authorized sandbox/staging testing; selecting a label does not make a live system safe. |
| Application build / version | Records the release used for this scenario. |
| Browser and operating system | Records the tested browser/OS combination. |
| Assistive technology / test method | Records NVDA/version, keyboard-only, or another method actually used. |
| Test authorization reference | Records the approved plan/ticket reference. It is not permission automatically granted by the tool. |
| Link existing findings (optional) | Associates selected findings from this report with the review. Linking does not resolve/change them; conflicting confirmed findings cannot justify a pass. |
| Latest review | Expands the most recent recorded outcome and its evidence/execution metadata. |
| Reviewed/pass/fail/blocked counts | Measures recorded workbook progress, not financial accessibility certification or professional experience. |

Use synthetic data and simulated transactions. Missing authorization or unavailable environments should be recorded honestly as constraints/blocked work, not invented passing evidence. See the [financial assessment operating guide](financial-assessment-guide.md) for the full workflow.

## 15. Remediation backlog

Purpose: turn findings into tracked work across completed scans of a website. The agent does not automatically edit the audited application's source code.

| Option | Purpose / use |
| --- | --- |
| Show: Open items | Lists active work. |
| Show: Not found in latest scan — verify | Finds candidates for retesting. Absence is not verified closure. |
| Show: Closed items | Includes Fixed (awaiting retest), Verified, Will not fix, and False positive in the current UI grouping. “Closed” therefore does not mean all of these are verified fixes. |
| Show: All items | Removes the status filter. The dashboard renders up to 300 matching rows; use the CSV for a larger backlog. |
| Add this report's findings | Synchronizes a saved completed report into the website backlog. Completed scan findings are also added automatically; duplicate synchronization is detected. |
| Status | Records workflow status; see meanings below. |
| Owner | Assigns a responsible person/team as text. This does not send them a notification or create an external ticket. |
| Due | Records a target date. It does not schedule a reminder. |
| Notes | Records implementation, triage, and retest context. |
| Save | Saves the edited row. Changing fields without pressing Save does not persist the update. |
| Export CSV | Downloads the website backlog for sharing/tracking. |

Statuses: **Open** = work pending; **In progress** = work underway; **Fixed (awaiting retest)** = claimed repair, not verified; **Verified** = reviewer-recorded verification; **Reopened** = finding returned; **Will not fix** = recorded disposition, not accessibility success; **False positive** = triage decision needing rationale.

The latest-scan column distinguishes **found**, **not found — verify**, and **page not covered**. An item found again after fixed/verified status is reopened. A missing item is not automatically marked verified. Partial scans do not provide completed-scan closure evidence.

## 16. Compare reports

| Option | Purpose / use |
| --- | --- |
| First report / Second report | Selects two completed runs of the same hostname. Either selection order is allowed; earlier/later is determined from the records. Other hostnames are disabled after choosing a report. |
| Compare | Computes matched confirmed-finding differences. Use comparable roles, scope, environments, and builds for meaningful interpretation. |
| Reset comparison | Clears selections/results only. Saved reports are not deleted. |
| Back to report | Returns to the single-report workspace. |
| All / New / Fixed / Unresolved | Filters the comparison groups. New = observed only later in comparable coverage; Fixed = no longer observed in matched later coverage; Unresolved = observed in both. “Fixed” is the UI's comparison label, not proof of a human-verified fix or full WCAG pass. |
| Finding / View screenshots | Opens earlier/later evidence side by side. A baseline can supply context but is labeled as context, not proof of a pass. |
| Earlier scan / Later scan crawl graph | Shows each run's own observed coverage so scope differences remain visible. |

Unmatched or unobserved pages/states are excluded from confident new/fixed claims and reported in comparison caveats. Read those caveats before presenting a regression or improvement count.

## 17. Downloads and exports

Several buttons sound similar but produce different artifacts:

| Button / location | Output and purpose |
| --- | --- |
| JSON — report header | Machine-readable report for diagnostics, integrations, and evidence inspection. |
| Export ACR — report header | The review CSV export, despite the shorter button label. It is not the edition-specific Word document. |
| Download CSV — VPAT / ACR heading | The same review CSV route as Export ACR. |
| Download draft HTML — VPAT / ACR heading | Readable working audit report with findings/review material. |
| Download HTML / Download Word — VPAT 2.5 export | Edition-specific VPAT-structured ACR using saved product details and reviewer decisions. Unreviewed rows remain Not Evaluated; pending rows keep the export in draft status. |
| Download checklist CSV | Regulatory/imported checklist requirements and recorded decisions for the report. |
| Export CSV — Remediation | Website-level fix backlog rather than a conformance report. |

Downloads do not change the tested website or run a new test. Review files before external sharing: screenshots/transcripts may contain visible application data even though secrets are excluded from intended credential payloads. Exported CSV/Word/HTML is reporting material, not automatic certification.

## 18. Common questions and limitations

| Question / symptom | Explanation / next step |
| --- | --- |
| Why does New scan not clear every value? | It is navigation to the form, not a full reset. Check existing settings before pressing Start scan. |
| Why keep Page limit when we test states? | URL breadth and interaction depth are different budgets. One URL can have many states. |
| Will more states make NVDA read everything? | No. More reachable states can add coverage, but NVDA has its own cap, sampled commands, reading timeout, and focus constraints. |
| NVDA is greyed out. | Read the availability reason; resolve its installation/profile/configuration/backend prerequisite. |
| I heard speech, but the report says Blocked. | The app needs valid in-scope execution/capture, not merely a running NVDA process. Review the stored reason and transcript/command counts. |
| NVDA reads only part of the site. | Check selected/tested/attempted state counts, configured test groups, reading completion, limits, blocked states, and focus/recovery notes. |
| No screenshots open; localhost refused connection. | The local server is unreachable. Keep the intended `npm start` server running. A missing image file is a separate problem from connection refusal. |
| Failed to fetch / scan start unconfirmed. | Check the backend terminal and saved reports before retrying; the first request may have started a run. Do not assume missing locators or repeatedly launch scans. |
| Port 4173 already in use. | Another process is listening there. Identify the intended dashboard process; do not start duplicates or kill unrelated processes. |
| Why did Do not click miss my intended element? | Check the parsed entry, actual text/alt/attribute/URL/selector, application scope, and whether it was a website-triggered background change rather than an agent action. Use stable metadata and an authorized fixture to verify exclusions. |
| No issues / zero warnings / high score. | Means only that the observed checks produced that result. Unvisited content, human-only criteria, other languages/readers/devices, and complete user tasks can remain untested. |
| Financial profile or finished VPAT rows means SEBI approved? | No. The tool organizes evidence and reviewer entries. Applicable requirements, genuine engagements, expert review, and any formal approval remain outside an automatic scan. |
| Does this guide prove the current installed NVDA works? | No. It documents implementation and controls. A successful live run with scoped evidence is needed to verify your installed environment. |

## 19. Where these options live in the code

For engineers maintaining the UI or keeping this guide current:

| Area | Main source files |
| --- | --- |
| Labels, form fields, initial defaults, report panels | [Dashboard HTML](../public/index.html) |
| Navigation, theme, report selection, event wiring | [Dashboard entry point](../public/app.js) |
| Scan requests, login payload, progress, journey launch | [Scan feature](../public/features/scan.js), [scan API](../src/api/routes/scans.js), [journey API](../src/api/routes/journeys.js) |
| Availability messages and exclusion-entry preview | [Capabilities feature](../public/features/capabilities.js) |
| Action-exclusion parsing, matching, activation guards | [Action exclusions](../src/browser/action-exclusions.js) |
| Limits, server options, NVDA defaults | [Configuration](../src/config.js), [request validation](../src/scan-request.js) |
| Issues, graph, overview | [Findings](../public/features/findings.js), [graph](../public/features/graph.js), [overview](../public/features/overview.js) |
| NVDA/tree results and screenshots | [Assistive-technology UI](../public/features/assistive-technology.js), [NVDA live lifecycle](../src/assistive-technology/nvda-live.js) |
| VPAT, regulatory checklists, financial/manual review | [Audit feature](../public/features/audit.js), [report modules](../src/report/) |
| Backlog and comparisons | [Remediation](../public/features/remediation.js), [comparison](../public/features/comparison.js) |

For component ownership and safe development/testing, see the [architecture and contributor guide](architecture.md). This user guide does not change runtime behavior or replace a release-specific test report.
