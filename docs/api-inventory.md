# API endpoint inventory

This inventory lists every backend endpoint of the dashboard, as found in the source code on 28 October 2026. The full contract is [openapi.json](openapi.json) (OpenAPI 3.0.3). The running server shows it in Swagger UI at `/api-docs` and serves the raw JSON at `/api/openapi.json`.

## Totals

| Item | Count |
| --- | --- |
| Express API routes that already existed (`src/api/routes/{health,scans,reports,compliance,backlog,journeys}.js`) | 23 |
| Documentation routes added (`src/api/routes/docs.js`) | 2 |
| Static file mount documented (`/reports`, `src/api/app.js:35`) | 1 |
| **Documented OpenAPI operations** | **37** (across 34 paths) |

The 23 existing routes, the 2 documentation routes and the 1 static mount make 26 implemented endpoints. The spec has 37 operations because the generic route `GET /api/reports/:id/:section` (`src/api/routes/reports.js:72-82`) appears as 12 concrete paths, one for each allowed section, so that each section has its own response schema. `npm run test:openapi` (`test/openapi.test.js`, also part of `npm test`) checks that all 25 Express routes are documented and that each documented path reaches the documented Express route. It also calls all 37 operations on an in-process server (see [Contract test](#contract-test)).

The dashboard UI files served at `/` from `public/` (`src/api/app.js:36`) are not API endpoints. They are mentioned in the spec description only.

## Access rules that apply to every endpoint

- **Authentication:** none. There is no login, API key or session (`src/api/middleware/local-request-guard.js:4`).
- **Host check:** the `Host` header must name `localhost`, `127.0.0.1`, `[::1]` or an entry in `DASHBOARD_ALLOWED_HOSTS`. Otherwise the server answers 421 (`local-request-guard.js:3,9-11`).
- **Origin check:** for methods other than GET, HEAD and OPTIONS, an `Origin` header with a host not on that list gets 403 (`local-request-guard.js:12-16`).
- **Error body:** `{"error": string}`. The status is `error.status`, or 404 for ENOENT, or 500 otherwise (`src/api/middleware/error-handler.js:3-8`).
- **Unmatched paths:** these get Express's HTML 404 page `Cannot <METHOD> <path>`.
- **Request bodies:** JSON only, at most 1 MB (`src/api/app.js:34`). A larger body gets 413. A non-UTF charset or an unknown `Content-Encoding` gets 415.

## Endpoints

Schema confidence:

- **Full:** the request and response shapes are fully established from code.
- **Partial:** some nested parts are open or unconfirmed. The spec marks them with `x-unconfirmed`.
- **Raw:** a file or binary passthrough.

| # | Method | Path | Tag | Purpose | Source | Schema confidence |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/api/health` | Health | Liveness and capability probe: browser channel, AI availability, server "Do not click" entries, NVDA readiness | `src/api/routes/health.js:5-16` | Full |
| 2 | POST | `/api/scans` | Scans & jobs | Validate a scan request, create a job, answer 202 and run the scan in the background | `src/api/routes/scans.js:19-101`; `src/scan-request.js:3-19` | Full (request and 202 body) |
| 3 | GET | `/api/jobs/{id}` | Scans & jobs | Poll a scan or journey job | `src/api/routes/scans.js:13-17`; `src/api/jobs/lifecycle.js:10-135` | Partial (event-specific event properties) |
| 4 | GET | `/api/reports` | Reports | List saved reports, newest first | `src/api/routes/reports.js:17-19`; `src/report/store.js:15-36` | Partial (`summary` keys vary by producer) |
| 5 | GET | `/api/reports/{id}` | Reports | Full report with review history, audit workspace and ACR rows | `src/api/routes/reports.js:21-23`; `src/report/store.js:38-61` | Partial (scanner item shapes) |
| 6 | POST | `/api/reports/{id}/reviews` | Reviews & audit | Append a documented manual review decision | `src/api/routes/reports.js:25-28`; `src/report/store.js:67-92`; `src/report/audit.js:117-165` | Full request; response as #5 |
| 7 | GET | `/api/reports/{id}/reviews` | Reviews & audit | Raw review history (section route) | `src/api/routes/reports.js:72-82` | Full |
| 8 | GET | `/api/reports/{id}/exports/{format}` | Reports | Download the report as JSON, ACR CSV or ACR HTML | `src/api/routes/reports.js:30-39`; `src/report/export.js:44-127` | CSV/HTML Raw; JSON as #5 |
| 9 | GET | `/api/reports/{id}/compare/{previousId}` | Reports | Compare with an older scan of the same site | `src/api/routes/reports.js:41-49`; `src/report/comparison.js:7-197` | Full |
| 10 | GET | `/api/reports/{id}/vpat-profile` | VPAT exports | Saved VPAT product details, or `{}` | `src/api/routes/reports.js:51-53`; `src/report/store.js:124-128` | Full |
| 11 | POST | `/api/reports/{id}/vpat-profile` | VPAT exports | Save or replace the VPAT product details | `src/api/routes/reports.js:55-57`; `src/report/store.js:121-146` | Full |
| 12 | GET | `/api/reports/{id}/vpat/{edition}/{format}` | VPAT exports | Download a VPAT 2.5-structured ACR (HTML or DOCX) | `src/api/routes/reports.js:59-70`; `src/report/vpat.js:8-13,106-236` | Raw document; headers and errors Full |
| 13 | GET | `/api/reports/{id}/overview` | Reports | Overview with score | `src/api/routes/reports.js:72-82`; `src/report/assessment.js:86-89` | Full (`summary` Partial) |
| 14 | GET | `/api/reports/{id}/score` | Reports | Observed accessibility health score | `src/report/assessment.js:32-82` | Full |
| 15 | GET | `/api/reports/{id}/issues` | Reports | Confirmed, needs-review and best-practice findings | `src/report/assessment.js:91` | Partial (finding shape) |
| 16 | GET | `/api/reports/{id}/pages` | Reports | Scanned page records | `src/report/assessment.js:92` | Partial (page record shape) |
| 17 | GET | `/api/reports/{id}/graph` | Reports | Crawl graph | `src/report/assessment.js:93` | Partial (node and edge shape) |
| 18 | GET | `/api/reports/{id}/activity` | Reports | Stored scan events | `src/report/assessment.js:94` | Partial (event-specific event properties) |
| 19 | GET | `/api/reports/{id}/acr` | Reviews & audit | ACR rows (WCAG criteria) | `src/report/assessment.js:95`; `src/scanner/wcag.js:94-120` | Full |
| 20 | GET | `/api/reports/{id}/audit` | Reviews & audit | Audit workspace | `src/api/routes/reports.js:77`; `src/report/audit.js:60-115` | Full |
| 21 | GET | `/api/reports/{id}/financial` | Reviews & audit | Financial scenario assessment, or `null` | `src/api/routes/reports.js:78`; `src/report/financial.js:93-118` | Full |
| 22 | GET | `/api/reports/{id}/evidence` | Reports | Findings grouped by screenshot | `src/report/assessment.js:112-152` | Full |
| 23 | GET | `/api/reports/{id}/assistive-technology` | Reports | Accessibility-tree and NVDA results | `src/report/assessment.js:97-107` | Partial (NVDA run records and states) |
| 24 | GET | `/api/compliance/sets` | Compliance checklists | Checklist catalogue (built-in and imported) | `src/api/routes/compliance.js:9-14`; `src/report/compliance.js:11-31` | Full (source entries come from the data file) |
| 25 | POST | `/api/compliance/sets` | Compliance checklists | Import or replace a custom checklist (JSON items or CSV text) | `src/api/routes/compliance.js:16-18`; `src/report/compliance.js:40-67,96-127` | Full |
| 26 | GET | `/api/reports/{id}/compliance` | Compliance checklists | Checklists with this report's decisions | `src/api/routes/compliance.js:20-22`; `src/report/compliance.js:69-87` | Full (built-in item keys come from the data file) |
| 27 | GET | `/api/reports/{id}/compliance/export.csv` | Compliance checklists | Checklists and decisions as CSV | `src/api/routes/compliance.js:24-29`; `src/report/compliance.js:89-94` | Raw CSV (columns Full) |
| 28 | GET | `/api/backlog/{host}` | Remediation backlog | Site backlog with summary | `src/api/routes/backlog.js:8-13`; `src/report/backlog.js:32-45,166-175` | Full |
| 29 | GET | `/api/backlog/{host}/export.csv` | Remediation backlog | Backlog as CSV | `src/api/routes/backlog.js:15-20`; `src/report/backlog.js:177-191` | Raw CSV (columns Full) |
| 30 | POST | `/api/backlog/{host}/sync` | Remediation backlog | Apply a completed report to the backlog | `src/api/routes/backlog.js:22-29`; `src/report/backlog.js:77-123` | Full |
| 31 | POST | `/api/backlog/{host}/track` | Remediation backlog | Add one finding to the backlog | `src/api/routes/backlog.js:31-37`; `src/report/backlog.js:125-140` | Full |
| 32 | PATCH | `/api/backlog/{host}/items/{key}` | Remediation backlog | Update status, owner, notes or due date | `src/api/routes/backlog.js:39-42`; `src/report/backlog.js:142-164` | Full |
| 33 | GET | `/api/journeys` | Journeys | List journey files and whether they are valid | `src/api/routes/journeys.js:13-15`; `src/journeys/runner.js:211-225` | Full |
| 34 | POST | `/api/journeys/run` | Journeys | Start a journey in the background (202 job) | `src/api/routes/journeys.js:17-47` | Full |
| 35 | GET | `/api/openapi.json` | Documentation | Raw OpenAPI document (added) | `src/api/routes/docs.js:13-19` | Full |
| 36 | GET | `/api-docs` | Documentation | Swagger UI page (added) | `src/api/routes/docs.js:21-56` | Full |
| 37 | GET | `/reports/{reportId}/{filePath}` | Static files | Raw saved report files and evidence (`express.static`) | `src/api/app.js:35`; `src/config.js:44` | Raw |

Rows 7 and 13-23 are the 12 sections of `GET /api/reports/:id/:section`. The allowed section names are listed at `src/api/routes/reports.js:74`.

## Unconfirmed or partially confirmed

These parts could not be fully established from the implementation. Each one is marked with `x-unconfirmed` in `openapi.json`.

1. **Job and report events** (`JobEvent`). `at`, `type`, `message` and `url` are confirmed. Other properties are passed through unchanged from each emitter in the scanner and journey code, and the set is open-ended.
2. **Report item shapes** (`Report`, `Finding`, `ReportGraph`, `PagesSection`, `AssistiveTechnologySection`). The top-level report keys, `configuration`, `audit`, `acr` and `auditReviews` are confirmed. The items of `pages[]`, `issues[]`, `incomplete[]` and `bestPractices[]`, graph nodes and edges, `assistiveTechnology.actualRuns`, `journey`, `android`, `documents` and `wcagRegistry` come from scanner, journey and Android modules that were not fully traced. They are documented as open objects, with the properties that the API code reads.
3. **Report `summary` keys** (`ReportSummaryCounts`). The keys depend on the producer and on the lifecycle stage. The crawl and journey keys are confirmed. The Android summary was not inspected.
4. **Compliance data keys** (`ComplianceSource`, `ComplianceItem`). The source fields and the built-in item fields `appliesTo`, `sourceTitle`, `sourceUrl` and the `confidence` values come from `src/report/compliance-data/public-sources.json`. The code does not enforce them.
5. **500 responses of `GET /api/reports` and `GET /api/journeys`.** These follow the error-handler format, but no reachable trigger was found, because both handlers catch directory and per-file errors.
6. **Headers of a VPAT rendering failure** (`GET /api/reports/{id}/vpat/{edition}/{format}`, 500). The error would be sent with the attachment header and the document `Content-Type` (`src/api/routes/reports.js:66-68`), but no trigger was found, so this was not observed.
7. **Environment-dependent values.** `.env` was not read. The values of `PORT`, `BROWSER_CHANNEL`, `OPENAI_API_KEY`, `NVDA_*`, `EXCLUDE_ACTION_LABELS` and `DASHBOARD_ALLOWED_HOSTS` on a given machine may differ from the defaults in `src/config.js` that the spec cites.

## Behaviour verified at runtime

The real Express app was run in-process against a throwaway reports folder, with stub scan and journey runners. The following dependency-level and edge-case behaviour was observed and is documented in the spec:

- the 413 and 415 messages from body-parser
- `HTTPS://` accepted as a `targetUrl`
- `%2F` decoded in static file paths
- the 301 redirect for report folders without a trailing slash
- the HTML 404 page for unmatched routes
- HEAD answered on GET routes
- the `text/csv` content type on backlog CSV error responses
- a 500 for the VPAT edition `constructor`
- a 500 for a `null` checklist item, but a 400 for a string item
- a 400 checklist-id error, not `A checklist is required.`, for a JSON array sent to `POST /api/compliance/sets`
- 200 `text/plain` with an `Allow` header for `OPTIONS` on a routed path
- the `_compliance` VPAT-profile caveat below, including the 500s it causes on the per-report compliance endpoints

Swagger UI 5.17.14 rendered all 37 operations, 75 models and 10 tags with no resolver errors. A "Try it out" POST from the page passed the Origin check.

## Contract test

`test/openapi.test.js` uses `node:test` and needs no browser, no network and no new dependencies. Run it with `npm run test:openapi` or as part of `npm test`.

1. **Structure.** It checks the required OpenAPI 3.0.3 fields, every `$ref`, path parameters against the path templates, unique operationIds, a description and a 2xx response on each operation, and the 3.0 schema keywords. Every example must be valid JSON where the media type is JSON and must validate against its schema.
2. **Route parity.** It builds the app with `createDashboardApp` and stub runners, then walks `app.router.stack` and the nested router stacks. Every Express route must be documented. For each documented path, the first matching route in stack order must be the documented one, which also checks that `/api/reports/{id}/compliance` is not caught by the generic section route.
3. **Live contract.** The test starts the app on `127.0.0.1` with a temporary project root and reports folder. It sends requests with `Host: localhost`. The temporary folder holds four synthetic reports: two scans of the same site, one other site and one interrupted report. The ids are the spec's own parameter examples, so the documented request examples run unchanged. All 37 operations are called. Each response's status code, `Content-Type` and JSON schema (including `additionalProperties: false`) are checked against the spec. The named error examples are matched exactly, and ENOENT messages are matched by pattern. The final step fails if any operation was not exercised with a 2xx response. Temporary folders are removed afterwards.

Two 400 examples need a link that resolves outside `reports/`, so the test does not trigger them: `Invalid report directory.` and `Invalid report file.` They are confirmed from `src/report/store.js:99,107`.

As a separate read-only check (not part of the test), the API data built from the 54 loadable local reports was validated against the response schemas with no errors. This covered the listing, full report, all sections, audit, compliance and VPAT profile.

## Validation corrections

These corrections were made after the contract test and a line-by-line comparison of each route file with the spec:

- **Report section 404s:** the 12 section paths listed `Unknown report section.` as a possible 404. That error comes only from section names outside the allow-list, so it cannot occur on a documented section path. The example was removed; each operation's description still explains the generic route's 404.
- **Per-report compliance 500s:** `GET /api/reports/{id}/compliance` and its CSV export did not document the 500 caused by a `reports/_compliance/*.json` file without `items`. That 500 is `Cannot read properties of undefined (reading 'map')`, from `src/report/compliance.js:77`. The 500 is now documented with an example, and the `POST /api/reports/{id}/vpat-profile` caveat names both endpoints.
- **Checklist import body:** the spec said a non-object body gets `A checklist is required.` A JSON array passes that check and fails on the checklist id instead (`src/report/compliance.js:43-45`).
- **Checklist import items:** the spec said a non-object item causes a 500. Only `null` does; a string item gets 400 `Item N needs a reference and a requirement.` (`src/report/compliance.js:54-56`).
- **OPTIONS:** the spec said every wrong method gets the HTML 404. `OPTIONS` on a routed path is answered by Express with 200 and an `Allow` header.
- **VPAT rendering failures:** the 500 listed a Word rendering failure as an `application/json` response. The attachment header and the document `Content-Type` are set before rendering (`src/api/routes/reports.js:66-68`), so such an error would carry those headers. This is now described and marked `x-unconfirmed`, because no input that makes rendering fail was found.

## Code quirks documented but not changed

The task was documentation only, so these are described in the spec rather than fixed:

- `GET /api/backlog/{host}/export.csv` sends its JSON error bodies with `Content-Type: text/csv` and an attachment header (`src/api/routes/backlog.js:18`).
- VPAT edition values that are inherited object property names, such as `constructor`, pass the route check and cause a 500 (`src/api/routes/reports.js:62`; `src/report/vpat.js:140`).
- The checklist id regex allows 61 characters, but its error message says 2-60 (`src/report/compliance.js:45`).
- `POST /api/reports/_compliance/vpat-profile` succeeds. After that, `GET /api/compliance/sets` returns 500, and so do `GET /api/reports/{id}/compliance` and its CSV export for every report, until `reports/_compliance/vpat-profile.json` is removed (`src/report/store.js:94-101,130-146`; `src/api/routes/compliance.js:12`; `src/report/compliance.js:77`).
- A `null` entry in the checklist `items` gives a 500 instead of a 400 (`src/report/compliance.js:54`). A string entry gives the expected 400.
- ENOENT 404 messages include absolute server filesystem paths (`src/api/middleware/error-handler.js:4,7`).
- With the real crawler, closing the test browser ends the job as `failed`, not `stopped`. `stopped` comes from an NVDA interruption (`src/scanner/crawl/run.js:251-281`; `src/api/jobs/lifecycle.js:121-127`).

## Relation to the earlier `openapi.yaml`

`docs/openapi.yaml` is an earlier snapshot with 34 operations across 31 paths and no documentation routes. `docs/openapi.json` replaces it. Checked against the code, the YAML has these gaps:

- no 415 responses and no explicit 421 responses
- the "Do not click" list is modelled as `maxItems: 100`, but the real limit is 100 distinct entries after normalisation and after merging with `EXCLUDE_ACTION_LABELS`
- website-login strings have `maxLength` values, but the code silently truncates them
- the NVDA `reason` is marked nullable, but it is always a string
- job `progress` is typed `number`, but it is always an integer
- `targetUrl` has the case-sensitive pattern `^https?://`, but the code accepts any letter case for the scheme
