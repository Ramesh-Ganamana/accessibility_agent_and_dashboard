# API handoff for the UI developer

The Swagger/OpenAPI specification is [openapi.json](openapi.json). It describes the backend as of **28 October 2026**: **37 documented operations across 34 paths**. The [endpoint inventory](api-inventory.md) lists them, with source references and the parts that could not be confirmed. The generic report-section route is expanded into its 12 supported section URLs so each response has its own model. The earlier [openapi.yaml](openapi.yaml) snapshot (34 operations across 31 paths) is replaced by `openapi.json`.

The running dashboard serves the document at `/api/openapi.json` and a Swagger UI page at `/api-docs` (`src/api/routes/docs.js`). These two documentation routes are the only backend change. No scanning, reporting or other API behavior was changed.

## Open the Swagger document

With the backend running, open `http://localhost:4173/api-docs` (Swagger UI loads from cdn.jsdelivr.net, so it needs internet access). You can also import `docs/openapi.json` into your team's Swagger Editor, Swagger UI or OpenAPI-compatible API client. It is an OpenAPI **3.0.3** JSON document. A visual preview works without running the backend. The specification uses synthetic examples; `app.example.test` is a placeholder, not a runnable demo website.

To make actual requests, start the existing backend yourself in a terminal:

```powershell
npm start
```

The default base URL is `http://localhost:4173`. Keep that terminal open; Ctrl+C stops the server. If the port is already occupied, identify the existing dashboard rather than starting a second copy. This handoff does not launch a background service.

For a quick read-only check:

```powershell
Invoke-RestMethod -Uri 'http://localhost:4173/api/health'
Invoke-RestMethod -Uri 'http://localhost:4173/api/reports'
```

The server binds to `127.0.0.1`. Each developer's `localhost` refers to their own computer. A remote UI cannot use your laptop's localhost URL as a shared backend.

For a frontend on another local port, configure that frontend's development proxy for **both `/api` and `/reports`**. Then use relative URLs such as `fetch('/api/health')`. Different ports are different browser origins, and this backend does not add CORS response headers. A hosted Swagger Editor can preview the document, but its **Try it out** requests to this local backend may be blocked by the origin policy. Use an approved local API client or same-origin/proxied setup to execute requests.

## Start a scan and load its result

1. Call `GET /api/health` to show available capabilities. NVDA availability is a configuration check, not a passed live test.
2. Submit `POST /api/scans` with JSON. The response is **202** and contains a **job ID**.
3. Poll `GET /api/jobs/{jobId}` about once per second. Back off after transient connection errors.
4. Stop polling on `complete`, `stopped` or `failed`. Display warnings and errors without treating partial coverage as a pass.
5. When `reportId` exists, load `GET /api/reports/{reportId}` or the section endpoints needed by the screen. A report ID may appear while the scan is still running.
6. Use `GET /api/reports` for saved history. Jobs are kept in memory; a backend restart loses job lookup data, while saved report files remain.

Example request:

```json
{
  "targetUrl": "https://app.example.test/",
  "maxPages": 5,
  "maxStates": 20,
  "maxDepth": 2,
  "device": "desktop",
  "audit": { "profile": "general", "wcagVersion": "2.2", "level": "AA" },
  "screenReaders": { "nvda": false },
  "aiEnabled": false,
  "excludeActionLabels": ["Delete account", "Pay now", "#dangerous-action"],
  "auth": { "enabled": false }
}
```

Replace the placeholder URL with an application authorized for testing before execution. `screenReaders.nvda: true` requests actual local NVDA and can bring the Windows test browser to the foreground and speak. The separate `auth` object is for the **website under test**, not dashboard API authentication. Login selectors are optional; the backend already has automatic discovery/default behavior.

| Job status | UI behavior |
| --- | --- |
| `queued`, `running` | Show phase, approximate progress, recent events and warnings; keep polling. |
| `complete` | Open the report and show its actual coverage and findings. This does not mean accessibility passed. |
| `stopped` | Show `stopReason` and the partial report, when available. Do not present it as full coverage. |
| `failed` | Show `error`; retain a link to any saved partial report. |

Do not retry a scan/journey POST automatically when its response is lost. There is no idempotency key; the first request may already have started work. Read-only GET retries are appropriate. Job IDs and report IDs are different identifiers.

## Which API each screen uses

All paths below are relative to the backend. `{id}` means a **report ID**, except in the job endpoint above.

| UI area | Request | Response shape |
| --- | --- | --- |
| Capabilities | `GET /api/health` | Health object with AI, exclusion and NVDA configuration details |
| Saved scans | `GET /api/reports` | Raw array of summaries, newest first |
| Full report | `GET /api/reports/{id}` | Full report object |
| Overview | `GET /api/reports/{id}/overview` | Summary plus assessment; no report `status` field here |
| Score | `GET /api/reports/{id}/score` | Assessment object; `score` can be `null` |
| Findings | `GET /api/reports/{id}/issues` | `{confirmed, needsReview, bestPractices}` arrays |
| Page coverage | `GET /api/reports/{id}/pages` | `{pages: [...]}` |
| Crawl graph | `GET /api/reports/{id}/graph` | `{nodes: [...], edges: [...]}` |
| Activity | `GET /api/reports/{id}/activity` | `{events: [...]}` |
| ACR rows | `GET /api/reports/{id}/acr` | `{rows: [...]}` |
| Audit workspace | `GET /api/reports/{id}/audit` | Raw audit object |
| Financial workspace | `GET /api/reports/{id}/financial` | Guided-review object, or `null` for general audits |
| Review history | `GET /api/reports/{id}/reviews` | Raw array |
| Save review | `POST /api/reports/{id}/reviews` | **201 with the updated full report** |
| Screenshot gallery | `GET /api/reports/{id}/evidence` | Groups, screenshot URLs and findings lacking references |
| Screen-reader results | `GET /api/reports/{id}/assistive-technology` | `{metadata, runs, summary, states}` |
| Compare reports | `GET /api/reports/{id}/compare/{previousId}` | Groups, counts, graphs and coverage exclusions |
| VPAT metadata | `GET /api/reports/{id}/vpat-profile` | Saved fields or `{}` |
| Save VPAT metadata | `POST /api/reports/{id}/vpat-profile` | Normalized saved fields; omitted fields become empty |
| Checklist catalog | `GET /api/compliance/sets` | Catalog; `sets[].items` is a **count** |
| Import checklist | `POST /api/compliance/sets` | **201** with ID, title and item count |
| Report checklists | `GET /api/reports/{id}/compliance` | Catalog; `sets[].items` is now a **full array** |
| Remediation | `GET /api/backlog/{host}` | Backlog items, synced report IDs and summary |
| Sync completed scan | `POST /api/backlog/{host}/sync` | Added/reopened/not-found counts |
| Track finding | `POST /api/backlog/{host}/track` | **201** with backlog item |
| Update backlog item | `PATCH /api/backlog/{host}/items/{key}` | Updated item |
| Journey selection | `GET /api/journeys` | Raw array of valid and invalid local definitions |
| Run journey | `POST /api/journeys/run` | **202** job; use the same polling flow |

`{host}` is an application hostname such as `app.example.test`, without protocol, port or path. A backlog item's `key` is not the same as a report finding's `id`.

## Reviews, imports and downloads

Get review target IDs from the report; do not generate them in the frontend. Every submitted review needs `kind`, `targetId`, `status`, `reviewer`, `scope`, `notes` and 1–30 `evidence` references. Evidence references are text, not uploaded files.

| Review kind | Allowed submitted statuses |
| --- | --- |
| `criterion`, `vpat-row` | `Supports`, `Partially Supports`, `Does Not Support`, `Not Applicable` |
| `check` | `pass`, `fail`, `not-applicable` |
| `financial-step` | `pass`, `fail`, `blocked`, `not-applicable` |
| `compliance-item` | `met`, `partially-met`, `not-met`, `not-applicable` |

Financial-step reviews additionally require execution details. The specification documents the fields and evidence-conflict checks. `Not Evaluated` and `not-reviewed` describe pending results; they are not valid submitted decisions.

Checklist imports accept JSON items or CSV text **inside JSON**. Importing an existing custom ID replaces that checklist. Built-in IDs cannot be replaced. Use returned compliance `targetId` values when saving checklist decisions.

| Download | Supported formats |
| --- | --- |
| `/api/reports/{id}/exports/{format}` | `json`, `csv`, `html` |
| `/api/reports/{id}/vpat/{edition}/{format}` | Editions `wcag`, `508`, `eu`, `int`; formats `html`, `docx` |
| `/api/reports/{id}/compliance/export.csv` | All report checklist sets as CSV |
| `/api/backlog/{host}/export.csv` | Backlog CSV |

Use `Content-Disposition` for download filenames. Word downloads are binary, not JSON. There is no PDF export endpoint.

Screenshot URLs are served from the existing static `/reports` mount, for example `/reports/{id}/evidence/001-example.png`. Use returned `evidenceUrl` when supplied; it can be `null`. NVDA run artifacts can have paths such as `evidence/nvda/...`; those are separate from the finding-gallery grouping. Resolve report-relative artifact paths against the correct report ID, do not hard-code old report URLs, and show an unavailable state if an artifact cannot be loaded. Static-file failures may return HTML. The backend must remain reachable for localhost image links to work.

## Integration limits to preserve in the UI

- There is no API-key, bearer-token or user-login system for this dashboard. Do not confuse test-site credentials with API authentication or expose this loopback service as a production API without additional design work.
- Normal API errors are `{ "error": "message" }`. Handle `400`, `403`, `404`, `409`, `413`, `421`, `500` and network failures; a network failure is not evidence that a form needs manual selectors.
- Report list/detail adjust abandoned `in-progress` reports to `interrupted` at runtime. Section/export endpoints do not perform that adjustment. Use list/detail for lifecycle status.
- A finished crawl can have blocked branches or limits reached. Missing coverage, review items and unavailable NVDA results must remain visible.
- No server-side list pagination/filtering, cancellation, arbitrary journey upload, report deletion, evidence upload or streaming progress endpoint exists. Build around the documented contract rather than inventing routes.
- Responses retain engine-specific and historical fields. Optional or absent fields should be handled gracefully. Escape finding HTML and other captured website text when displaying it.
- Automated scores and generated VPAT/ACR documents are audit support. They do not establish a completed manual audit, professional qualifications or regulatory approval.

## Source locations

| Responsibility | Source |
| --- | --- |
| App assembly, middleware and static files | `src/api/app.js` |
| Listen address and port | `src/server.js` |
| Health | `src/api/routes/health.js` |
| Scan creation and job lookup | `src/api/routes/scans.js` |
| Job progress and terminal states | `src/api/jobs/lifecycle.js` |
| Reports, sections, reviews and exports | `src/api/routes/reports.js` |
| Compliance | `src/api/routes/compliance.js` |
| Remediation | `src/api/routes/backlog.js` |
| Journey execution | `src/api/routes/journeys.js` |
| Local request guard and error formatting | `src/api/middleware/` |
| Scan request validation | `src/scan-request.js` |
| Report models and review validation | `src/report/` |

Keep `docs/openapi.json` synchronized when those routes or their request/response models change. It is a hand-maintained contract, not automatically generated from Express. Run `npm run test:openapi` afterwards (`test/openapi.test.js`, also part of `npm test`): it validates the document and every example, fails if an Express route is missing from the document or a documented path reaches a different route, and calls every documented operation on an in-process server to check status codes, content types, response schemas and error messages.
