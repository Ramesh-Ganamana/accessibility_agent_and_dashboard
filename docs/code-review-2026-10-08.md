# Code review and bug fixes — 8 October 2026

Reviewed the application backend, crawler, authentication and dialog handling, reporting, dashboard, NVDA adapter, Windows helpers, capture add-on, and verification scripts. Existing work in the workspace was preserved. This review does not establish that every possible defect or website-specific behavior has been eliminated.

## Fixes

| Area | Defect corrected | Result |
| --- | --- | --- |
| Crawl configuration | A depth of zero was replaced by a default; malformed numeric budgets were accepted. | Zero depth is preserved and budgets are bounded whole numbers. |
| Navigation | Direct link discovery bypassed action restrictions and per-application exclusions. | Discovery applies the same restrictions before queuing navigation. |
| Click safety | Default buttons outside forms were skipped, while child spans could bypass submission or mutable-control restrictions. | Ordinary buttons are discoverable; nested submit, disabled, checkbox, and switch controls remain excluded. |
| AI action fallback | Synthetic DOM clicks could bypass blocking overlays and mutable controls. | Actionability checks, safe-control filtering, and page readiness apply to the selected action. |
| Dialog recovery | Duplicate control keys and changing dialog text could falsely indicate recovery. | Controls have unique keys and dialog disappearance is verified. |
| Keyboard evidence | Similar controls could produce the same target path and prematurely end traversal. | Target paths resolve to the observed element. |
| Finding classification | Keyboard-focus heuristics and AI alt-text judgments could become confirmed findings. | These appear under Needs review, with evidence and review history. AI check counts use recorded review attempts. |
| Comparisons | Hash routes, origins, and frame identities could be conflated; redirects could imply an issue was fixed. | Comparison identities retain those distinctions and redirected pages do not establish requested-route coverage. |
| Score | Failed pages could increase the coverage denominator and improve the score. | Failed pages are excluded from successfully observed coverage. |
| ACR / VPAT | No recorded failure was treated as Supports, including unevaluated criteria. | Such criteria remain Not Evaluated; pending findings are explicitly counted. |
| URL handling | Embedded URL credentials and tokens in hash-route queries could remain in report links or errors. | Sensitive parameters and user information are removed while application routes are preserved. |
| Dashboard evidence | Empty filters or empty reports could leave an old screenshot selected. | Selection and evidence clear together. |
| Crawl graph | Different states at the same URL showed each other's findings. | Nodes carry an exact finding state and selection filters by that state. |
| Dashboard status | Temporary connection loss was shown as a stopped scan. | The last known progress is retained and status polling retries. Confirmed server failures still show as failures. |
| Report loading | Load errors could appear only in a hidden comparison area; selection races could overwrite the chosen report. | The visible report workspace shows errors and stale requests are guarded. |
| Scan API | Malformed settings could be acknowledged before throwing and leave a stuck job. | Settings are validated and configuration is prepared before the job is acknowledged. Error handling avoids printing request bodies. |
| NVDA speech | English word filtering discarded real website controls named Close, Back, or Reload. | The add-on checks document ancestry; website control speech is retained and browser-toolbar speech is excluded. |
| NVDA reliability | A full event buffer broke capture cursors; Windows helpers could hang; failed process checks could misidentify an existing NVDA session. | Capture uses monotonic cursors, helpers have timeouts, and process checks have a guarded Windows fallback. |
| NVDA execution status | A run with no executed actions could appear completed. | Such runs remain blocked/not executed. Outdated capture add-ons receive an explicit update instruction. |
| NVDA keyboard handling | An unreliable renderer-focus call interfered with traversal. | The unused renderer manipulation was removed; foreground checks are repeated before subsequent native keys. Browser maximization remains enabled. |

## Verification

- Full Node test suite: **45 passed, 0 failed, 0 skipped**.
- Sixteen local browser fixtures passed: authentication, action-triggered login, post-login setup, navigation races, protected-route replay, safe actions, blocker recovery, interaction crawling, AI grounding and its crawl integration, review evidence, accessibility-tree capture, dashboard tabs, comparison, score/API sections, and live status.
- Real NVDA/Chrome fixture: **1 page, 4 native keyboard commands, 4 webpage announcements, 0 warnings**, including a website button named Close. The dedicated browser launched maximized.
- Capture add-on unit checks: **4 passed**, including browser-toolbar exclusion, legitimate Close buttons, document boundaries, protected fields, and unrelated foreground applications.
- JavaScript and PowerShell syntax checks and Git whitespace checks passed.
- The image-review regression uses a mocked model response. No external model call was made for that test.

## Applying the changes

The corrected capture add-on (version 1.2.0) was installed into the existing dedicated NVDA profile. Restart the dashboard server with `npm start`, then run a new scan. Existing historical reports retain their previously recorded results.

No deployment or push was performed. Validation used local fixture sites; the paid live AI-authentication test and customer-site end-to-end scans were not run. NVDA validation covers the Windows/Chrome keyboard-focus flow, not full screen-reader workflow certification.
