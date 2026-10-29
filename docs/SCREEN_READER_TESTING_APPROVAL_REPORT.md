# Accessibility Agent: Screen-Reader Testing Approval Report

**Purpose:** Management approval for extending the accessibility automation agent from browser accessibility-tree readiness checks to controlled testing with real screen-reader products.

## Executive summary

The project currently provides automated accessibility scanning, interaction crawling, WCAG issue detection, evidence capture, report comparison, and browser accessibility-tree inspection. It can show the roles, names, values, states, landmarks, headings, and approximate reading sequence exposed by Chromium.

This is valuable automated coverage, but it is not equivalent to operating the application with NVDA, JAWS, VoiceOver, or TalkBack. Real screen-reader execution is the remaining step required to validate what users actually hear and whether they can complete important workflows using a keyboard, touch gestures, or screen-reader navigation commands.

Approval is requested for a phased implementation beginning with NVDA on Windows, followed by JAWS, VoiceOver, and TalkBack when the required licences and platform runners are available.

## Why screen readers are important

Screen readers convert the semantic information exposed by an application into speech or braille. They are used primarily by people who are blind, people with significant low vision, and users who cannot reliably interpret the visual interface.

Real screen-reader testing verifies matters that visual inspection and static rules cannot fully prove:

- Whether controls are announced with understandable names and roles.
- Whether focus moves in a logical order and remains visible and predictable.
- Whether headings, landmarks, lists, tables, and form relationships support efficient navigation.
- Whether validation errors and live updates are announced at the correct time.
- Whether dialogs receive focus, identify themselves, and return focus when closed.
- Whether expanded, collapsed, selected, checked, disabled, required, and invalid states are communicated.
- Whether a user can complete login, navigation, search, forms, and other critical workflows without sight.
- Whether product-specific screen-reader modes, commands, and browser combinations behave correctly.

## Screen-reader products and their uses

### NVDA

NVDA is a free, widely used Windows screen reader. It is important for validating keyboard-driven web workflows in common Windows browser combinations. It is the recommended first integration because the current project runs on Windows and NVDA does not require a commercial licence.

**Testing value:** spoken announcements, browse mode, focus mode, heading and landmark navigation, form operation, dialog behavior, live regions, and keyboard-only task completion.

### JAWS

JAWS is a major commercial Windows screen reader used in many enterprises, government organizations, and regulated environments. Applications can behave differently in JAWS and NVDA, so testing only one does not guarantee equivalent behavior in the other.

**Testing value:** enterprise Windows compatibility, JAWS virtual cursor behavior, forms mode, tables, custom widgets, scripted applications, and browser-specific behavior.

**Requirement:** a valid JAWS licence and a dedicated Windows test runner.

### VoiceOver

VoiceOver is built into macOS, iPhone, and iPad. It is essential for applications used by Apple customers. Its navigation model and announcements differ from Windows screen readers.

**Testing value:** macOS keyboard navigation, Safari compatibility, rotor navigation, iOS touch gestures, focus behavior, and mobile application or responsive-web accessibility.

**Requirement:** a macOS runner for desktop testing and an iOS simulator or physical Apple device for mobile testing.

### TalkBack

TalkBack is the primary Android screen reader. It is required to validate Android and mobile-web experiences that depend on touch exploration and accessibility gestures.

**Testing value:** swipe navigation, touch exploration, gesture-based activation, mobile form behavior, dynamic announcements, and Android browser or application compatibility.

**Requirement:** an Android emulator or physical Android device configured with TalkBack and ADB-based automation support.

## Coverage already implemented

The current accessibility agent includes the following capabilities:

1. **Automated WCAG scanning**
   - Runs axe-core rules against crawled application states.
   - Records confirmed findings and findings requiring human review.
   - Associates findings with WCAG criteria, selectors, pages, and states.

2. **Application crawling and interaction discovery**
   - Crawls normal links and safe clickable controls.
   - Handles buttons, links, tabs, clickable containers, supported spans and divs, dialogs, popups, frames, and open Shadow DOM.
   - Supports both single-page and multi-page application navigation.
   - Applies page/state/depth limits and avoids known destructive actions.

3. **Authentication and post-login handling**
   - Supports configured username, password, and optional tenant/domain/workspace values.
   - Preserves authenticated sessions when enabled.
   - Keeps passwords, tokens, cookies, and entered values local.

4. **Situation-triggered blocker recovery**
   - Activates only when an actual modal or overlay obstructs crawling.
   - Attempts visible Close/X/Dismiss, Cancel, Skip, Not now, Maybe later, Escape, and restoration of the previous safe state.
   - Does not fill or alter arbitrary dialog inputs.
   - Records unresolved blockers instead of silently claiming complete coverage.

5. **Evidence and traceability**
   - Captures screenshots and highlighted visual evidence.
   - Removes duplicate screenshot storage and merges exact duplicate visual findings while preserving occurrence information.
   - Maintains crawl history, page states, navigation edges, warnings, limitations, and termination reasons.

6. **Reporting and comparison**
   - Provides overview, issue, crawl-graph, evidence, VPAT/ACR, and comparison views.
   - Compares only reports from the same application domain.
   - Classifies new, fixed, and unresolved findings.
   - Provides an accessibility score and grade based on automated report data.

7. **Screen-reader readiness inspection**
   - Captures Chromium's real browser accessibility tree for newly scanned states.
   - Records exposed roles, accessible names, values, descriptions, and states.
   - Counts controls, headings, landmarks, dialogs, images, and live regions.
   - Flags unnamed controls, dialogs, and images, missing headings, and missing main landmarks.
   - Shows an approximate announcement sequence for each captured page/frame/state.
   - Clearly identifies NVDA, JAWS, VoiceOver, and TalkBack as **Not run** unless an actual product executes the test.

As an example, the displayed Feuji report inspected 10 browser accessibility-tree states and produced no structural tree warnings for the selected state. This means no configured structural warning was detected there; it does not prove complete screen-reader accessibility.

## Why the capabilities built so far are necessary

The work completed so far forms the foundation required before real screen-reader automation can be reliable. Each capability solves a different part of the accessibility-testing problem.

### 1. Automated WCAG scanning

**What we are doing:** The agent runs axe-core checks against each captured application state and classifies results as confirmed findings or items requiring human review.

**Why we need it:** Many accessibility defects can be detected quickly and consistently from code and browser semantics. Examples include missing alternative text, invalid ARIA attributes, insufficient color contrast, missing form labels, and incorrect role relationships. Automating these checks reduces repetitive manual work and gives developers precise WCAG criteria and element paths for remediation.

**Benefit:** Fast baseline coverage, consistent rule execution, earlier defect detection, and lower manual testing effort.

### 2. Deep application crawling

**What we are doing:** The agent discovers and safely operates links, buttons, tabs, clickable containers, supported spans and divs, dialogs, popups, frames, and open Shadow DOM while respecting configured depth and state limits.

**Why we need it:** Accessibility problems are not limited to the landing page. They often appear after opening menus, switching tabs, launching dialogs, applying filters, or navigating into deeper routes. A scanner that evaluates only the first page gives an incomplete and potentially misleading result.

**Benefit:** Broader coverage of real user journeys and dynamic states that conventional URL-only scanners may miss.

### 3. Authentication and session preservation

**What we are doing:** The agent can enter configured login credentials, support multi-stage login, provide an optional tenant/domain/workspace value, and retain an authenticated local session.

**Why we need it:** Important business functions usually exist behind authentication. Without login handling, the scanner would evaluate only public pages and could not inspect dashboards, employee portals, financial workflows, administrative screens, or other protected areas.

**Benefit:** Accessibility assessment of the actual product experience, not only its public login page.

### 4. Intelligent readiness waiting

**What we are doing:** The crawler waits for navigation and useful page readiness, but continues as soon as a stable, usable state is available rather than always consuming the maximum timeout.

**Why we need it:** Modern applications may load data, components, frames, or post-login content asynchronously. Scanning too early produces incomplete screenshots, missing controls, and inaccurate findings. Waiting a fixed long period on every page would make scans unnecessarily slow.

**Benefit:** More reliable state capture with reasonable execution time across both single-page and multi-page applications.

### 5. Situation-triggered blocker recovery

**What we are doing:** When a genuine modal or overlay obstructs the page, the agent attempts safe dismissal actions in order: Close/X/Dismiss, Cancel, Skip, Not now, Maybe later, Escape, and restoration of the previous safe state. It does not alter arbitrary dialog inputs.

**Why we need it:** Cookie prompts, promotional dialogs, announcements, and optional onboarding overlays can prevent access to underlying controls. Applying dismissal logic on every page would be unsafe, so recovery runs only when an obstruction is detected.

**Benefit:** Continued crawling without application-specific hard-coding, while protecting required forms and user data.

### 6. Safe-action policy

**What we are doing:** The crawler excludes actions that appear destructive, mutating, disabled, covered, unlabeled, or unsafe to execute automatically.

**Why we need it:** A crawler must not delete data, submit transactions, sign users out, deactivate accounts, or trigger irreversible operations simply to obtain coverage.

**Benefit:** Safer testing in shared or realistic environments and a lower risk of business-data damage.

### 7. Frames, popups, and Shadow DOM support

**What we are doing:** The agent attempts to inspect same-origin and supported cross-origin frames independently, follows browser windows and popups, and traverses open Shadow DOM.

**Why we need it:** Enterprise applications commonly embed authentication, payment, help, document, or micro-frontend content in frames and web components. Ignoring these surfaces leaves significant portions of the user experience untested.

**Benefit:** Better coverage of modern component-based and multi-window applications, with explicit limitations when browser security prevents access.

### 8. Evidence screenshots and DOM targeting

**What we are doing:** Each finding can include a screenshot, highlighted visual location, DOM selector, page URL, frame, and interaction state.

**Why we need it:** A rule name alone is rarely enough for developers or reviewers to understand where a defect occurred. Evidence connects the technical finding to the visible interface and the state in which it was detected.

**Benefit:** Faster reproduction, clearer communication, easier remediation, and stronger audit evidence.

### 9. Duplicate-evidence removal

**What we are doing:** The agent hashes screenshot content, stores identical images once, and merges exact duplicate highlighted findings while preserving their occurrence history.

**Why we need it:** Dynamic crawling can encounter the same visual state through multiple navigation paths. Repeating the same screenshot and issue makes reports confusing, inflates counts, increases storage, and hides genuinely distinct defects.

**Benefit:** Cleaner reports, more trustworthy totals, reduced storage, and easier review.

### 10. Confirmed findings versus needs-review findings

**What we are doing:** Deterministic failures are reported separately from results that automation cannot decide confidently. Needs-review items retain screenshots and review history.

**Why we need it:** Some WCAG questions depend on meaning and context—for example, whether alternative text accurately represents an image or whether a heading is appropriate. Automation must not present uncertain judgments as confirmed failures or passes.

**Benefit:** Honest reporting, fewer false claims, and a clear queue for human validation.

### 11. Crawl graph and execution history

**What we are doing:** The report records visited pages and states, transitions, actions, blockers, warnings, errors, and termination reasons in a crawl graph and event history.

**Why we need it:** Reviewers need to know not only what was found but also what was actually tested, what could not be reached, and why crawling stopped. A result without coverage information can create false confidence.

**Benefit:** Transparent coverage, easier debugging, and evidence of blocked or untested branches.

### 12. Report comparison

**What we are doing:** Users can select two reports from the same application and review new, fixed, and unresolved findings with supporting screenshots. Cross-site comparison is prevented.

**Why we need it:** Accessibility work is continuous. Teams need to prove whether a release improved the application, introduced regressions, or left known problems unresolved. Comparing unrelated domains would produce misleading results.

**Benefit:** Regression tracking, measurable remediation progress, and clear release-to-release evidence.

### 13. Accessibility score and grade

**What we are doing:** The dashboard summarizes automated results in a score and grade derived from the report's severity, confirmed findings, review items, and observed coverage.

**Why we need it:** Managers need a concise indicator for tracking progress across releases, while developers still require the detailed issue list underneath it.

**Benefit:** Easier prioritization and trend communication. The score is a project health indicator, not a legal certification or substitute for manual testing.

### 14. VPAT/ACR-oriented reporting

**What we are doing:** The agent organizes findings against applicable WCAG criteria and prepares VPAT/ACR-oriented report data for review.

**Why we need it:** Customers, procurement teams, compliance teams, and auditors often need criterion-based accessibility information rather than a raw technical defect list.

**Benefit:** Reduces reporting effort and creates a structured starting point for human-reviewed conformance documentation. Automated output must still be validated before publication.

### 15. Browser accessibility-tree inspection

**What we are doing:** For each new page, frame, and interaction state, the agent captures the Chromium accessibility tree and displays exposed roles, names, values, descriptions, states, and an approximate announcement sequence.

**Why we need it:** The accessibility tree is the semantic interface consumed by screen readers. A control can look correct visually while exposing no useful name or state. Inspecting the tree identifies these structural problems earlier and helps developers understand what assistive technologies are likely to receive.

**Benefit:** Fast screen-reader-readiness feedback across many states before slower product-specific testing begins.

### 16. Honest assistive-technology status

**What we are doing:** NVDA, JAWS, VoiceOver, and TalkBack remain marked **Not run** until those actual products execute a test.

**Why we need it:** Browser-tree inspection is not identical to real screen-reader behavior. Claiming that a product passed when it never ran would create compliance, contractual, and reputational risk.

**Benefit:** Trustworthy reports that distinguish automated readiness, actual assistive-technology execution, and human validation.

## How the existing foundation supports the proposed screen-reader phases

The current crawler already discovers states, authenticates, waits for readiness, handles safe blockers, records evidence, and preserves execution history. Real screen-reader adapters can reuse those captured workflows instead of rebuilding the entire scanning system.

The intended testing pipeline is:

1. Discover the page and interaction state safely.
2. Run automated WCAG checks.
3. Inspect the browser accessibility tree.
4. Select representative and critical workflows for actual screen-reader execution.
5. Run the appropriate product-specific adapter.
6. Compare expected and actual announcements and focus behavior.
7. Store transcripts, screenshots, status, and review history in the same report.
8. Require human validation for uncertain or high-risk results.

This layered design provides broad automated coverage first and applies slower, platform-specific screen-reader testing where it produces the greatest value.

## Current limitation

The agent currently predicts screen-reader readiness from the Chromium accessibility tree. It does not yet launch the four named screen readers, execute their product-specific commands, or record their actual spoken output.

Therefore, the current system cannot yet claim that:

- A workflow passed in NVDA, JAWS, VoiceOver, or TalkBack.
- The exact spoken announcement is correct.
- Browse mode, virtual cursor, rotor navigation, or touch gestures work correctly.
- A user can complete an entire business workflow with a particular screen reader.
- The application is certified as conformant based solely on automation.

## Proposed implementation

### Phase 1: NVDA on Windows

- Install and configure NVDA on a dedicated Windows test runner.
- Define safe, repeatable scenarios for headings, landmarks, links, controls, forms, dialogs, validation messages, and live regions.
- Drive keyboard navigation and capture NVDA Speech Viewer output.
- Record announcements, focus transitions, screenshots, execution history, failures, and items requiring review.
- Import results into the existing dashboard with statuses such as Passed, Failed, Blocked, and Needs review.

### Phase 2: JAWS on Windows

- Obtain an approved JAWS licence.
- Add a dedicated JAWS adapter and product-specific scenarios.
- Compare results with NVDA to identify compatibility differences.

### Phase 3: VoiceOver

- Provision a macOS test runner for Safari and VoiceOver.
- Add iOS simulator or physical-device coverage when mobile testing is required.
- Validate keyboard, rotor, touch, focus, and announcement behavior.

### Phase 4: TalkBack

- Provision an Android emulator or physical Android test device.
- Automate navigation through ADB and supported accessibility/test interfaces.
- Capture gesture outcomes, accessibility events, screenshots/video, and review evidence.

## Recommended reporting model

Each product result should include:

- Screen reader, version, operating system, browser, and browser version.
- Page, application state, and tested workflow.
- Commands or gestures executed.
- Expected and actual announcement.
- Focus before and after each action.
- Passed, Failed, Blocked, or Needs review status.
- Screenshot, transcript, and execution history.
- Limitation or reason when a result cannot be completed.

Real screen-reader results should remain separate from browser-tree readiness results so stakeholders cannot mistake automated structural inspection for product certification.

## Expected benefits

- Detects accessibility failures before release and reduces remediation cost.
- Provides evidence that critical workflows were tested using actual assistive technology.
- Improves confidence for blind and low-vision users.
- Reduces false confidence from rule-only automation.
- Supports procurement, compliance, audit, and VPAT/ACR review activities.
- Gives developers reproducible announcements and focus histories for faster debugging.
- Enables regression comparison after application changes.
- Creates a scalable process while retaining human review for subjective or uncertain behavior.

## Risks and controls

- **Automation cannot replace users:** retain manual testing by experienced screen-reader users for critical releases.
- **Product behavior differs:** report each screen-reader/browser/platform combination independently.
- **Licensing and infrastructure:** approve JAWS licensing and macOS/Android runner availability before those phases.
- **Dynamic applications can be unstable:** use explicit readiness conditions, bounded retries, and truthful Blocked results.
- **Sensitive data:** continue excluding passwords, tokens, cookies, and private input values from external evidence and model requests.
- **False certification claims:** label automated readiness, actual product execution, and human validation separately.

## Approval requested

Approval is requested to:

1. Implement Phase 1 real NVDA testing on a dedicated Windows runner.
2. Define and approve representative critical workflows for initial testing.
3. Evaluate JAWS licensing and dedicated macOS/iOS and Android test infrastructure for later phases.
4. Preserve the current browser accessibility-tree inspection as the fast first layer while adding product-specific execution as a separate evidence layer.

## Recommended decision

Approve Phase 1 with NVDA first. It provides the fastest path to genuine screen-reader execution using the current Windows environment. Use the results to validate the reporting model and automation reliability before funding the JAWS, VoiceOver, and TalkBack runners.
